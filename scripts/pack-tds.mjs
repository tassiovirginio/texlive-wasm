#!/usr/bin/env node
/**
 * pack-tds.mjs — pack engine-artifacts/texmf/ into compressed tarballs for
 * runtime download + decompression.
 *
 * Full bundle (default):
 *   engine-artifacts/texmf.tar.gz   gzip-9 (size tracks the fetch-tds.sh package set)
 *   engine-artifacts/texmf.tar.br   brotli-11 (~18 MB; Chrome 121+/FF 127+)
 *
 * Core bundle (`--tier core --engine <id>`): the subset a mobile app
 * preloads at engine init — patterns from scripts/data/core-tier.list plus
 * scripts/data/core-tier.<engine>.list (the engine's .fmt and friends):
 *   engine-artifacts/texmf-core-<engine>.tar.gz / .tar.br
 * The long tail is then served on-miss by lazy backends (TauriFS/OPFS/CDN).
 * ls-R is intentionally excluded: the worker regenerates an exact db from
 * whatever is actually loaded (see src/core/lsr.ts).
 *
 * The tar is written by a minimal pure-JS USTAR writer (sorted entries,
 * zeroed mtime/uid/gid) so the bytes are reproducible and the script runs
 * identically on Linux, macOS and Windows — no GNU tar required.
 *
 * Usage:
 *   node scripts/pack-tds.mjs
 *   node scripts/pack-tds.mjs --tier core --engine pdflatex
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as zlibC } from 'node:zlib';
import { join, relative } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = join(REPO_ROOT, 'engine-artifacts');

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const pack = argOf('--pack');
if (pack && !['portuguese', 'multilingual'].includes(pack))
  throw new Error('Unknown resource pack');
const customSource = argOf('--source');
const customStem = argOf('--stem');
if (customStem && !/^[a-z0-9-]+$/.test(customStem)) throw new Error('Invalid archive stem');
const TEXMF = customSource
  ? customSource
  : pack
    ? join(ARTIFACTS, 'resource-packs', pack)
    : join(ARTIFACTS, 'texmf');
const tier = argOf('--tier') ?? 'full';
const engine = argOf('--engine');
// Brotli-11 on a multi-hundred-MB tar costs many minutes. The release only
// publishes the gzip (WebKit has no DecompressionStream('br')), so the release
// path passes --no-brotli and does not pay for an archive nobody ships.
const noBrotli = args.includes('--no-brotli');
if (tier !== 'full' && tier !== 'core') {
  console.error(`pack-tds: unknown --tier ${tier} (full|core)`);
  process.exit(1);
}
if (tier === 'core' && !engine) {
  console.error('pack-tds: --tier core requires --engine <id>');
  process.exit(1);
}

const stem = customStem
  ? customStem
  : pack
    ? `texmf-pack-${pack}`
    : tier === 'core'
      ? `texmf-core-${engine}`
      : 'texmf';
const TAR_GZ = join(ARTIFACTS, `${stem}.tar.gz`);
const TAR_BR = join(ARTIFACTS, `${stem}.tar.br`);

try {
  statSync(TEXMF);
} catch {
  console.error(`texmf not found at ${TEXMF}. Run scripts/fetch-tds.sh first.`);
  process.exit(1);
}

const matcher = tier === 'core' ? loadCoreMatcher(engine) : null;

console.error(`[pack-tds] creating ${stem} tar archive (reproducible, pure JS)...`);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (st.isFile()) files.push(full);
  }
})(TEXMF);

const chunks = [];
let packed = 0;
for (const abs of files) {
  const tds = relative(TEXMF, abs).replaceAll('\\', '/');
  if (matcher && !matcher(tds)) continue;
  if (matcher && tds === 'ls-R') continue; // worker regenerates an exact db
  const rel = 'texmf/' + tds;
  const data = readFileSync(abs);
  chunks.push(ustarHeader(rel, data.length), data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad));
  packed++;
}
chunks.push(Buffer.alloc(1024)); // two empty 512-byte end blocks
const tar = Buffer.concat(chunks);
console.error(
  `[pack-tds] tar: ${(tar.length / 1024 / 1024).toFixed(1)} MB (${packed}/${files.length} files)`,
);

if (tar.length > 512 * 1024 * 1024)
  throw new Error('Bundle exceeds the runtime decompression limit; split the resource profile');
console.error('[pack-tds] gzip-9...');
const gz = gzipSync(tar, { level: 9 });
writeFileSync(TAR_GZ, gz);
console.error(`[pack-tds]   → ${TAR_GZ}: ${(gz.length / 1024 / 1024).toFixed(1)} MB`);

if (noBrotli) {
  console.error('[pack-tds] brotli skipped (--no-brotli)');
} else {
  console.error('[pack-tds] brotli-11 (slow)...');
  const br = brotliCompressSync(tar, {
    params: {
      [zlibC.BROTLI_PARAM_QUALITY]: 11,
      [zlibC.BROTLI_PARAM_LGWIN]: 24,
    },
  });
  writeFileSync(TAR_BR, br);
  console.error(`[pack-tds]   → ${TAR_BR}: ${(br.length / 1024 / 1024).toFixed(1)} MB`);
}

console.error('[pack-tds] done');

/** Compile core-tier.list (+ per-engine list) into a path predicate. */
function loadCoreMatcher(engineId) {
  const lists = [
    join(REPO_ROOT, 'scripts/data/core-tier.list'),
    join(REPO_ROOT, `scripts/data/core-tier.${engineId}.list`),
  ];
  const patterns = [];
  for (const list of lists) {
    if (!existsSync(list)) continue;
    for (const raw of readFileSync(list, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      patterns.push(globToRegex(line));
    }
  }
  if (patterns.length === 0) {
    console.error(`pack-tds: no core-tier patterns found for ${engineId}`);
    process.exit(1);
  }
  return (tdsPath) => patterns.some((re) => re.test(tdsPath));
}

function globToRegex(glob) {
  // Supported: `**` (any depth), `*` (single segment), literal otherwise.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`);
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
  buf[155] = 0x20;
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
  throw new Error(`pack-tds: path too long for USTAR (${path})`);
}

function writeOctal(buf, offset, len, value) {
  const str = value.toString(8).padStart(len - 1, '0');
  buf.write(str + '\0', offset, len);
}
