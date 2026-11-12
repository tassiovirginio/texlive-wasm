#!/usr/bin/env node
/**
 * Pack the contents of `engine-artifacts/` into per-asset tar.gz archives,
 * write a `checksums.json` manifest, and stage everything under `release/`
 * ready to attach to a GitHub Release.
 *
 *   node scripts/pack-release.mjs [--out release] [--version v0.1.0]
 *                                 [--license path/to/LICENSE.TL] [--skip-license]
 *
 * Output layout (release/):
 *   pdflatex-emscripten.tar.gz       — pdflatex/{js,wasm} + NOTICE + LICENSE.TL
 *   xelatex-emscripten.tar.gz        — xelatex/{js,wasm}
 *   lualatex-emscripten.tar.gz       — lualatex/{js,wasm}
 *   bibtexu-emscripten.tar.gz        — bibtexu/{js,wasm}
 *   xdvipdfmx-emscripten.tar.gz      — xdvipdfmx/{js,wasm}
 *   makeindex-emscripten.tar.gz      — makeindex/{js,wasm}
 *   pdflatex-wasi.tar.gz             — pdflatex/wasi/*.wasm (when present)
 *   icudt78l.dat.gz                  — ICU data (single gzipped file)
 *   texmf.tar.gz                     — full TDS bundle (from scripts/pack-tds.mjs)
 *   texmf-core-<engine>.tar.gz       — per-engine core TDS bundle (idem)
 *   checksums.json                   — { version, generatedAt, assets: { name: { size, sha256 } } }
 *
 * The TDS bundles are NOT re-packed here: `scripts/pack-tds.mjs` already
 * writes reproducible tarballs into engine-artifacts/, and this script copies
 * them through verbatim so the bytes a consumer downloads are the bytes the
 * demo and the Tauri example were tested against. The names are the contract
 * the library's `bundleUrl` and examples/tauri's HEAD probe rely on.
 *
 * Tar format is a minimal USTAR writer (no native dep, identical bytes on
 * every host). All entries inside a per-engine archive are stored under that
 * engine's name so consumers can untar straight into `<dest>/`.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ENGINES = [
  'pdflatex',
  'xelatex',
  'lualatex',
  'bibtexu',
  'xdvipdfmx',
  'makeindex',
  // biber's dir also carries biber-vfs.tar.gz (the Perl runtime tree) —
  // packed into the same per-engine archive automatically.
  'biber',
];

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'release' },
      version: { type: 'string', default: '' },
      artifacts: { type: 'string', default: 'engine-artifacts' },
      license: { type: 'string', default: '' },
      'skip-license': { type: 'boolean', default: false },
      'allow-version-mismatch': { type: 'boolean', default: false },
    },
  });

  const artifactsDir = resolve(ROOT, values.artifacts);
  const outDir = resolve(ROOT, values.out);

  if (!existsSync(artifactsDir)) {
    console.error(
      `pack-release: ${artifactsDir} does not exist. Run \`npm run engines:build\` first ` +
        `or copy the engine outputs into ./engine-artifacts/.`,
    );
    process.exit(1);
  }

  const license = await loadTexLiveLicense(values.license, values['skip-license'], artifactsDir);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const version = resolveVersion(
    values.version,
    await packageVersion(),
    values['allow-version-mismatch'],
  );
  const assets = {};

  for (const engine of ENGINES) {
    for (const target of ['emscripten', 'wasi']) {
      const engineDir = join(artifactsDir, engine, target);
      if (!existsSync(engineDir)) continue;
      const files = await collectFiles(engineDir);
      if (files.length === 0) continue;
      assertNoEmptyFiles(files, `${engine}/${target}`);
      // Regenerated on every pack — a stale NOTICE/LICENSE.TL from an earlier
      // run must not end up as a duplicate tar entry.
      const staged = files.filter((f) => f.rel !== 'NOTICE' && f.rel !== 'LICENSE.TL');
      staged.push({
        rel: 'NOTICE',
        content: Buffer.from(noticeText(engine, license !== null), 'utf8'),
      });
      // The engine binaries are derived works of TeX Live: its license file
      // travels with them, not just a pointer to it.
      if (license) staged.push({ rel: 'LICENSE.TL', content: license });
      const archive = join(outDir, `${engine}-${target}.tar.gz`);
      await writeTarGz(archive, staged, `${engine}/${target}/`);
      assets[`${engine}-${target}.tar.gz`] = await hashAndSize(archive);
      console.log(`packed ${engine}-${target}.tar.gz (${staged.length} files)`);
    }
  }

  const icuPath = join(artifactsDir, 'icudt78l.dat');
  if (existsSync(icuPath)) {
    assertNonEmptyFile(icuPath);
    const dest = join(outDir, 'icudt78l.dat.gz');
    await gzipFile(icuPath, dest);
    assets['icudt78l.dat.gz'] = await hashAndSize(dest);
    console.log('packed icudt78l.dat.gz');
  }

  const bundles = findTdsBundles(artifactsDir);
  for (const { name, path } of bundles) {
    assertNonEmptyFile(path);
    const dest = join(outDir, name);
    await copyFile(path, dest);
    assets[name] = await hashAndSize(dest);
    console.log(`staged ${name} (${(assets[name].size / 1024 / 1024).toFixed(1)} MB)`);
  }

  // Fallback for trees packed without pack-tds.mjs: publish the raw TDS as the
  // full bundle rather than shipping a release with no TeX tree at all. The
  // per-engine core bundles can only come from pack-tds (they need the
  // scripts/data/core-tier.* pattern lists), so say so.
  const texmfDir = join(artifactsDir, 'texmf');
  if (bundles.length === 0 && existsSync(texmfDir) && statSync(texmfDir).isDirectory()) {
    const files = await collectFiles(texmfDir);
    if (files.length > 0) {
      // No empty-file assertion here: TeX Live legitimately ships zero-byte
      // files (tex/latex/standalone/standalone.tex), and dropping them would
      // break kpathsea lookups.
      const dest = join(outDir, 'texmf.tar.gz');
      await writeTarGz(dest, files, 'texmf/');
      assets['texmf.tar.gz'] = await hashAndSize(dest);
      console.log(
        `packed texmf.tar.gz (${files.length} files) — run scripts/pack-tds.mjs ` +
          `--tier core --engine <id> for the per-engine core bundles`,
      );
    }
  }

  for (const name of readdirSync(artifactsDir).filter((n) =>
    /^tex-packages(?:-[a-z]+)?\.json$/.test(n),
  )) {
    const source = join(artifactsDir, name);
    const manifest = JSON.parse(await readFile(source, 'utf8'));
    if (manifest.version.replace(/^v/, '') !== version.replace(/^v/, ''))
      throw new Error(`Manifest version mismatch: ${name}`);
    const dest = join(outDir, name);
    await copyFile(source, dest);
    assets[name] = await hashAndSize(dest);
  }

  if (existsSync(join(artifactsDir, 'resource-packs.json'))) {
    const catalog = JSON.parse(await readFile(join(artifactsDir, 'resource-packs.json'), 'utf8'));
    if (catalog.version.replace(/^v/, '') !== version.replace(/^v/, ''))
      throw new Error('Resource pack catalog version mismatch');
    await copyFile(join(artifactsDir, 'resource-packs.json'), join(outDir, 'resource-packs.json'));
    assets['resource-packs.json'] = await hashAndSize(join(outDir, 'resource-packs.json'));
  }
  for (const name of ['font-packs.json', 'texlive-package-index.json']) {
    if (!existsSync(join(artifactsDir, name))) continue;
    if (name === 'font-packs.json') {
      const catalog = JSON.parse(await readFile(join(artifactsDir, name), 'utf8'));
      if (catalog.version.replace(/^v/, '') !== version.replace(/^v/, ''))
        throw new Error('Font catalog version mismatch');
      for (const pack of Object.values(catalog.families)) {
        const staged = assets[pack.url];
        if (!staged || staged.sha256 !== pack.sha256 || staged.size !== pack.size)
          throw new Error('Font catalog asset mismatch: ' + pack.url);
      }
    }
    await copyFile(join(artifactsDir, name), join(outDir, name));
    assets[name] = await hashAndSize(join(outDir, name));
  }
  const checksums = {
    version,
    generatedAt: new Date().toISOString(),
    assets,
  };
  await writeFile(join(outDir, 'checksums.json'), JSON.stringify(checksums, null, 2));
  console.log(
    `wrote ${Object.keys(assets).length} archives + checksums.json to ${relative(ROOT, outDir)}/`,
  );
}

async function packageVersion() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return `v${pkg.version}`;
}

async function collectFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const name of await readdir(d)) {
      const full = join(d, name);
      const st = await stat(full);
      if (st.isDirectory()) await walk(full);
      else if (st.isFile()) out.push({ abs: full, rel: relative(dir, full), size: st.size });
    }
  }
  await walk(dir);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * A zero-byte engine artifact is a failed build that still produced a file
 * (a truncated link, an `emcc` that died after creating its output). Packing
 * it publishes a placeholder that fails at instantiation time on a user's
 * device, so refuse the whole release instead of quietly shipping it.
 */
function assertNoEmptyFiles(files, label) {
  const empty = files.filter((f) => f.size === 0);
  if (empty.length === 0) return;
  console.error(`pack-release: ${label} contains ${empty.length} zero-byte file(s):`);
  for (const f of empty) console.error(`  ${join(label, f.rel)}`);
  console.error('pack-release: rebuild the engine — refusing to pack a placeholder asset.');
  process.exit(1);
}

/**
 * The version stamped into checksums.json IS the asset manifest's version, and
 * the contract (README "Version contract") is that it equals the wrapper's npm
 * version and the release tag. Packing assets under a version the wrapper does
 * not carry is how a release ends up with tag vX but a package.json saying vY —
 * the state that blocked publishing v0.2.2-alpha.
 */
function resolveVersion(flagVersion, pkgVersion, allowMismatch) {
  if (!flagVersion) return pkgVersion;
  // packageVersion() already carries the leading "v"; --version may or may not.
  if (flagVersion.replace(/^v/, '') === pkgVersion.replace(/^v/, '')) return pkgVersion;
  const message =
    `pack-release: --version ${flagVersion} disagrees with package.json (${pkgVersion}). ` +
    `The wrapper version, the release tag and checksums.json must be the same version — ` +
    `bump package.json, or pass --allow-version-mismatch for a throwaway local pack.`;
  if (!allowMismatch) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  return flagVersion;
}

function assertNonEmptyFile(path) {
  if (statSync(path).size > 0) return;
  console.error(`pack-release: ${relative(ROOT, path)} is zero bytes — refusing to pack it.`);
  process.exit(1);
}

/**
 * TDS bundles produced by scripts/pack-tds.mjs. Names are the published
 * contract: `texmf.tar.gz` (full) and `texmf-core-<engine>.tar.gz` (the tier a
 * mobile app preloads). Brotli siblings stay out of the release — WebKit has
 * no DecompressionStream('br'), so the gzip bundle is the one every target can
 * unpack.
 */
function findTdsBundles(artifactsDir) {
  const found = [];
  for (const name of readdirSync(artifactsDir).sort()) {
    if (name === 'texmf.tar.gz' || /^texmf-(?:core|pack|font)-[A-Za-z0-9-]+\.tar\.gz$/.test(name)) {
      const path = join(artifactsDir, name);
      if (statSync(path).isFile()) found.push({ name, path });
    }
  }
  return found;
}

/**
 * TeX Live's own license file, shipped inside every binary archive because the
 * engines are derived works of it. Not carried in this repo (texlive-source
 * has no LICENSE.TL) — a TeX Live installation root does, and CI stages it.
 */
async function loadTexLiveLicense(flagPath, skip, artifactsDir) {
  if (skip) {
    console.warn(
      'pack-release: --skip-license — archives will ship without LICENSE.TL. Local packs only.',
    );
    return null;
  }
  const candidates = [
    flagPath ? resolve(ROOT, flagPath) : null,
    process.env.TEXLIVE_LICENSE_FILE ? resolve(process.env.TEXLIVE_LICENSE_FILE) : null,
    join(ROOT, 'LICENSE.TL'),
    join(ROOT, 'vendor', 'texlive-source', 'LICENSE.TL'),
    join(artifactsDir, 'LICENSE.TL'),
    join(artifactsDir, 'texmf', 'LICENSE.TL'),
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const bytes = await readFile(path);
    if (bytes.byteLength === 0) {
      console.error(`pack-release: ${path} is empty — that is not a license file.`);
      process.exit(1);
    }
    console.log(`license: ${relative(ROOT, path) || basename(path)} (${bytes.byteLength} bytes)`);
    return bytes;
  }
  console.error('pack-release: no LICENSE.TL found. Looked in:');
  for (const path of candidates) console.error(`  ${path}`);
  console.error(
    'pack-release: copy LICENSE.TL from a TeX Live installation root (it ships with every\n' +
      '  TL install and with the tlnet distribution), point --license / $TEXLIVE_LICENSE_FILE\n' +
      '  at it, or pass --skip-license for a local, non-publishable pack.',
  );
  process.exit(1);
}

async function hashAndSize(path) {
  const bytes = await readFile(path);
  return {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function gzipFile(srcPath, dstPath) {
  await mkdir(dirname(dstPath), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  await pipeline(createReadStream(srcPath), createGzip({ level: 9 }), createWriteStream(dstPath));
}

function noticeText(component, hasLicense) {
  const where = hasLicense
    ? 'See LICENSE.TL, shipped beside this NOTICE,'
    : 'See LICENSE.TL in a TeX Live installation root';
  return (
    `${component} — compiled to WebAssembly from TeX Live sources\n` +
    `(https://tug.org/texlive/, github.com/TeX-Live/texlive-source).\n\n` +
    `The binary in this archive is a derived work of TeX Live and retains\n` +
    `its upstream licenses (predominantly LPPL, GPL family, and\n` +
    `engine-specific terms). ${where}\n` +
    `for the full per-component breakdown. The texlive-wasm wrapper\n` +
    `library and build scripts are MIT-licensed.\n`
  );
}

async function writeTarGz(dstPath, files, prefix) {
  await mkdir(dirname(dstPath), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  async function* generate() {
    for (const f of files) {
      const data = f.content ?? (await readFile(f.abs));
      yield ustarHeader(prefix + f.rel.replaceAll('\\', '/'), data.length);
      yield data;
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(1024); // two empty 512-byte blocks
  }
  await pipeline(Readable.from(generate()), createGzip({ level: 9 }), createWriteStream(dstPath));
}

function ustarHeader(path, size) {
  const buf = Buffer.alloc(512);
  const { prefix, name } = splitUstarPath(path);
  buf.write(name, 0, 100);
  writeOctal(buf, 100, 8, 0o644); // mode
  writeOctal(buf, 108, 8, 0); // uid
  writeOctal(buf, 116, 8, 0); // gid
  writeOctal(buf, 124, 12, size); // size
  writeOctal(buf, 136, 12, 0); // mtime — zero for reproducible bytes
  buf.fill(0x20, 148, 156); // checksum placeholder (spaces)
  buf[156] = 0x30; // typeflag '0' regular file
  buf.write('ustar\0', 257, 6); // magic
  buf.write('00', 263, 2); // version
  if (prefix) buf.write(prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  writeOctal(buf, 148, 7, sum);
  buf[155] = 0x20; // checksum terminator is NUL + space per POSIX convention
  return buf;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  // Split on the last '/' that leaves name ≤ 100 and prefix ≤ 155.
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { prefix, name };
    }
  }
  throw new Error(`pack-release: path too long for USTAR (${path})`);
}

function writeOctal(buf, offset, len, value) {
  const str = value.toString(8).padStart(len - 1, '0');
  buf.write(str + '\0', offset, len);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
