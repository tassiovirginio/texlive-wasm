#!/usr/bin/env node
/**
 * texlive-wasm CLI — fetches engine artifacts and TDS bundles from the
 * matching GitHub Release.
 *
 *   npx @typeward/texlive-wasm download-assets [dest]
 *     Default dest:    ./public/texlive-wasm
 *     Default version: v<package.json version> (or $TEXLIVE_WASM_VERSION)
 *     Default assets:  all .tar.gz + icudt78l.dat.gz listed in the release's
 *                      checksums.json (the full TDS bundle is large — pass
 *                      --assets to narrow it down).
 *
 *   npx @typeward/texlive-wasm download-assets --tag v0.1.0 ./static/wasm
 *   npx @typeward/texlive-wasm download-assets --assets pdflatex-emscripten,texmf-core-pdflatex,icudt78l.dat.gz
 *     (asset names match checksums.json keys; the .tar.gz/.gz suffix may be omitted)
 *   npx @typeward/texlive-wasm version
 *
 * Engine archives are unpacked to <dest>/<engine>/<target>/ and the download
 * is discarded. TDS bundles (texmf.tar.gz, texmf-core-<engine>.tar.gz) are
 * BOTH unpacked to <dest>/texmf/ and kept as archives: the library's
 * `bundleUrl` — and examples/tauri's HEAD probe for
 * <dest>/texmf-core-<engine>.tar.gz — fetch the archive itself over HTTP.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { extractTarGz } = require('./lib/archive.cjs');

const packageRepository = require('../package.json').repository.url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
const REPO_OWNER = process.env.TEXLIVE_WASM_REPO_OWNER || packageRepository?.[1] || 'typeward';
const REPO_NAME = process.env.TEXLIVE_WASM_REPO_NAME || packageRepository?.[2] || 'texlive-wasm';

// Published TDS bundle names (scripts/pack-tds.mjs → scripts/pack-release.mjs).
const TDS_BUNDLE = /^texmf(-(core|pack|font)-[A-Za-z0-9-]+)?\.tar\.(gz|br)$/;

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  process.stdout.write(
    'Usage:\n' +
      '  texlive-wasm download-assets [--tag <tag>] [--assets a,b,c] [dest]\n' +
      '  texlive-wasm version\n' +
      '\n' +
      'Defaults:\n' +
      '  dest    ./public/texlive-wasm\n' +
      '  tag     v<package.json version>  (or env TEXLIVE_WASM_VERSION)\n' +
      '  assets  every .tar.gz + .dat.gz published with the release\n' +
      '\n' +
      'The wrapper version, the release tag and the version inside the release\'s\n' +
      'checksums.json must agree; download-assets refuses to mix them. Override\n' +
      'with --allow-version-mismatch (it downgrades the error to a warning).\n' +
      '\n' +
      'Assets:\n' +
      '  <engine>-emscripten   engine glue + wasm, unpacked to <dest>/<engine>/emscripten/\n' +
      '  texmf-core-<engine>   per-engine core TDS bundle: kept as .tar.gz AND unpacked\n' +
      '  texmf                 full TDS bundle (large): kept as .tar.gz AND unpacked\n' +
      '  icudt78l.dat.gz       ICU data, needed by xelatex and bibtexu\n',
  );
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag' || a === '-t') flags.tag = argv[++i];
    else if (a === '--assets' || a === '-a') flags.assets = argv[++i];
    else if (a === '--owner') flags.owner = argv[++i];
    else if (a === '--repo') flags.repo = argv[++i];
    else if (a === '--force' || a === '-f') flags.force = true;
    else if (a === '--no-verify') flags.noVerify = true;
    else if (a === '--allow-version-mismatch') flags.allowVersionMismatch = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else positional.push(a);
  }
  return { flags, positional };
}

(async () => {
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (command === 'version') {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    process.stdout.write(pkg.version + '\n');
    return;
  }
  if (command === 'download-assets') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (flags.help) {
      usage();
      return;
    }
    await downloadAssets({
      dest: positional[0] || './public/texlive-wasm',
      tag: flags.tag,
      assets: flags.assets ? flags.assets.split(',').map((s) => s.trim()).filter(Boolean) : null,
      owner: flags.owner || REPO_OWNER,
      repo: flags.repo || REPO_NAME,
      force: !!flags.force,
      verify: !flags.noVerify,
      allowVersionMismatch: !!flags.allowVersionMismatch,
    });
    return;
  }
  usage();
  process.exit(1);
})().catch((err) => {
  process.stderr.write(`texlive-wasm: ${err.message || err}\n`);
  process.exit(1);
});

async function downloadAssets(opts) {
  const dest = path.resolve(opts.dest);
  fs.mkdirSync(dest, { recursive: true });

  const tag = opts.tag || resolveTag();
  const baseUrl = `https://github.com/${opts.owner}/${opts.repo}/releases/download/${tag}`;
  log(`download-assets: target dir ${dest}`);
  log(`download-assets: source ${opts.owner}/${opts.repo} ${tag}`);

  const checksums = await fetchChecksums(opts.owner, opts.repo, tag);
  assertVersionsAgree(tag, checksums.version, opts.allowVersionMismatch);
  const available = Object.keys(checksums.assets ?? {});
  // Accept both "pdflatex-emscripten" and "pdflatex-emscripten.tar.gz":
  // checksums.json keys carry the archive suffix.
  const assetNames = (opts.assets ?? available.filter((name) => !name.endsWith('.tgz') && !name.startsWith('texmf-pack-') && !name.startsWith('texmf-font-') && name !== 'texlive-package-index.json' && name !== 'font-packs.json')).map((name) => {
    if (checksums.assets?.[name]) return name;
    const suffixed = available.find(
      (a) => a === `${name}.tar.gz` || a === `${name}.gz` || a === `${name}.dat.gz`,
    );
    return suffixed ?? name;
  });
  for (const name of assetNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`asset name "${name}" contains unsupported characters`);
    }
  }
  if (assetNames.length === 0) {
    throw new Error(
      `release ${tag} exposes no assets in checksums.json. Either build the release ` +
        `(scripts/pack-release.mjs + upload) or pass --assets explicitly.`,
    );
  }

  for (const name of assetNames) {
    const expected = checksums.assets?.[name];
    if (!expected && opts.verify) {
      throw new Error(
        `asset "${name}" missing from release ${tag} checksums.json. ` +
          `Pass --no-verify to bypass.`,
      );
    }
    const url = `${baseUrl}/${name}`;
    const tmpPath = path.join(dest, `.${name}.partial`);
    log(`fetch ${url}`);
    const buf = await fetchToBuffer(url, tmpPath);
    if (expected && opts.verify) {
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (sha !== expected.sha256) {
        throw new Error(
          `${name}: sha256 mismatch (expected ${expected.sha256}, got ${sha})`,
        );
      }
      if (expected.size !== buf.byteLength) {
        throw new Error(
          `${name}: size mismatch (expected ${expected.size}, got ${buf.byteLength})`,
        );
      }
    }
    if (TDS_BUNDLE.test(name)) {
      // A TDS bundle serves two consumers at once: the worker fetches the
      // archive by URL (bundleUrl / the Tauri core-bundle probe), while
      // TauriFS and the manifest backends read the unpacked tree. Keep both —
      // extracting and deleting the archive would break the first.
      fs.writeFileSync(path.join(dest, name), buf);
      if (name.startsWith('texmf-pack-') || name.startsWith('texmf-font-')) {
        log(`  kept optional resource pack ${name}`);
      } else if (name.endsWith('.tar.gz')) {
        await extractTarGz(buf, dest);
        log(`  kept ${name} and unpacked it into texmf/`);
      } else {
        // .tar.br — no DecompressionStream('br') in WebKit, so we never
        // publish these; if one shows up, keep the bytes and leave it alone.
        log(`  kept ${name}`);
      }
    } else if (name.endsWith('.tar.gz')) {
      await extractTarGz(buf, dest);
      log(`  unpacked ${name}`);
    } else if (name.endsWith('.gz')) {
      const raw = zlib.gunzipSync(buf, { maxOutputLength: 512 * 1024 * 1024 });
      const outPath = path.join(dest, name.replace(/\.gz$/, ''));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, raw);
      log(`  decompressed ${name} → ${path.basename(outPath)}`);
    } else {
      const outPath = path.join(dest, name);
      fs.writeFileSync(outPath, buf);
      log(`  wrote ${name}`);
    }
    try { fs.unlinkSync(tmpPath); } catch {}
  }
  log(`download-assets: done. ${assetNames.length} asset(s) installed under ${dest}`);
}

function resolveTag() {
  if (process.env.TEXLIVE_WASM_VERSION) return process.env.TEXLIVE_WASM_VERSION;
  return `v${wrapperVersion()}`;
}

function wrapperVersion() {
  return require(path.join(__dirname, '..', 'package.json')).version;
}

/**
 * The version contract: wrapper npm version == release tag == the `version`
 * inside that release's checksums.json. Engine assets are only guaranteed to
 * work with the wrapper they were built beside, and the failure mode of a
 * mismatch is not a clean error — it is an engine that loads a format file
 * from another TL build and dies inside kpathsea. So say so here, loudly,
 * where the two versions first meet.
 */
function assertVersionsAgree(tag, assetVersion, allow) {
  const wrapper = wrapperVersion();
  const bare = (v) => String(v).replace(/^v/, '');
  const problems = [];
  if (bare(tag) !== wrapper) {
    problems.push(`wrapper is ${wrapper} (expects tag v${wrapper}) but the tag is ${tag}`);
  }
  if (assetVersion && bare(assetVersion) !== wrapper) {
    problems.push(`checksums.json says version ${assetVersion}`);
  }
  if (!assetVersion) {
    problems.push(`checksums.json for ${tag} carries no version field`);
  }
  if (problems.length === 0) return;
  const message =
    `version mismatch: ${problems.join('; ')}.\n` +
    `  The wrapper, the release tag and the asset manifest must be the same version.\n` +
    `  Install the matching wrapper (npm i texlive-wasm@${tag.replace(/^v/, '')}), pass --tag v${wrapper},\n` +
    `  or pass --allow-version-mismatch if you really are mixing them on purpose.`;
  if (!allow) throw new Error(message);
  log(`WARNING: ${message}`);
}

async function fetchChecksums(owner, repo, tag) {
  const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/checksums.json`;
  log(`fetch ${url}`);
  const buf = await fetchToBuffer(url);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`checksums.json malformed at ${url}: ${e.message}`);
  }
}

async function fetchToBuffer(url, tmpPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'texlive-wasm-cli' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const maxBytes = 256 * 1024 * 1024;
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    throw new Error('Asset exceeds download limit');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of res.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Asset exceeds download limit');
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks, length);
  if (tmpPath) {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, buf);
  }
  return buf;
}

function log(msg) {
  process.stderr.write(`[texlive-wasm] ${msg}\n`);
}
