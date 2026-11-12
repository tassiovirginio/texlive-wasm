#!/usr/bin/env node
/**
 * validate-artifacts.mjs — pre-publish gate over a staged artifact directory.
 *
 *   node scripts/validate-artifacts.mjs <dir> [--engine <id>]
 *
 * Exit 0 when every artifact under <dir> passes; exit 1 with one line per
 * offending file otherwise. Accepts both shapes the pipeline produces:
 *
 *   staged/pdflatex.{js,wasm}                     (release.yml matrix leg)
 *   engine-artifacts/<engine>/<target>/<engine>.{js,wasm}   (packing tree)
 *
 * `--engine <id>` narrows the run to one engine and additionally requires
 * that engine's wasm to be present (a matrix leg that produced nothing must
 * fail, not pass vacuously).
 *
 * Symbol checks read the JS glue, not the wasm export section: emcc minifies
 * wasm export names at -O2+ (pdflatex.wasm exports read "L", "M", "aa", ...),
 * so the C symbol names only survive on the JS side, where the glue binds
 * them as `_texlive_mount_lazy` etc. The wasm itself is checked structurally
 * (magic, version, section framing, a non-empty export section) — that is
 * what catches the truncated/placeholder writes this gate exists for.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

// makeindex.wasm — the smallest engine we ship — is ~190 KB. A 64 KB floor
// sits well below every real build while still rejecting empty, truncated or
// placeholder outputs (emscripten.mk has historically staged a `.tmp` stub).
const MIN_WASM_BYTES = 64 * 1024;

// biber does not link scripts/wasmfs-lazy.c: its Perl runtime VFS mounts at
// the FS root rather than /texmf-dist, and the worker always materializes it
// eagerly. Requiring the lazy entry points there would fail every build.
const LAZY_EXEMPT_ENGINES = new Set(['biber']);

const LAZY_EXPORTS = ['_texlive_mount_lazy', '_texlive_touch', '_texlive_setenv'];

function usage() {
  process.stderr.write(
    'Usage: node scripts/validate-artifacts.mjs <dir> [--engine <id>]\n',
  );
}

const argv = process.argv.slice(2);
let dirArg;
let engineArg;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--engine' || a === '-e') engineArg = argv[++i];
  else if (a === '--help' || a === '-h') {
    usage();
    process.exit(0);
  } else if (a.startsWith('-')) {
    process.stderr.write(`validate-artifacts: unknown flag ${a}\n`);
    usage();
    process.exit(1);
  } else if (dirArg === undefined) dirArg = a;
  else {
    process.stderr.write(`validate-artifacts: unexpected argument ${a}\n`);
    usage();
    process.exit(1);
  }
}

if (!dirArg) {
  usage();
  process.exit(1);
}

const root = resolve(dirArg);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  process.stderr.write(`validate-artifacts: ${root} is not a directory\n`);
  process.exit(1);
}

const failures = [];
const passes = [];
const fail = (file, reason) => failures.push({ file, reason });

const files = walk(root);

// A zero-byte file anywhere in the staged tree is a broken build, whatever
// its role (glue, wasm, ICU data, biber VFS tarball). The TDS tree is the one
// exception: TeX Live really does ship empty files (tex/latex/standalone/
// standalone.tex, nucleardata.hd), and dropping them would break kpathsea.
for (const f of files) {
  if (f.size === 0 && !isTdsTreePath(f.rel)) fail(f.rel, 'zero-byte file');
}

// Compressed side-cars (biber-vfs.tar.gz, icudt78l.dat.gz, TDS bundles) must
// at least be gzip: a truncated download lands here first.
for (const f of files) {
  if (f.size > 0 && f.rel.endsWith('.gz')) {
    const head = readHead(f.abs, 2);
    if (head[0] !== 0x1f || head[1] !== 0x8b) fail(f.rel, 'not a gzip stream (bad magic)');
  }
}

const wasmFiles = files.filter((f) => f.rel.endsWith('.wasm'));
const selected = engineArg
  ? wasmFiles.filter((f) => basename(f.rel, '.wasm') === engineArg)
  : wasmFiles;

// An empty leg must fail rather than pass vacuously: a matrix job whose build
// silently produced nothing would otherwise sail through the gate.
if (selected.length === 0) {
  fail('.', engineArg ? `no ${engineArg}.wasm under ${root}` : `no .wasm artifact under ${root}`);
}

for (const f of selected) {
  const engine = basename(f.rel, '.wasm');
  // wasi builds are standalone modules with no JS glue; only the emscripten
  // leg carries the runtime the wrapper drives.
  const isWasi = f.rel.split(/[\\/]/).includes('wasi');
  checkWasm(f);
  if (!isWasi) checkGlue(f, engine);
}

for (const p of passes) process.stdout.write(`ok    ${p}\n`);
for (const { file, reason } of failures) process.stderr.write(`FAIL  ${file}: ${reason}\n`);

if (failures.length > 0) {
  process.stderr.write(
    `validate-artifacts: ${failures.length} problem(s) in ${root}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `validate-artifacts: ${selected.length} engine artifact(s) OK in ${root}\n`,
);

function checkWasm(f) {
  if (f.size === 0) return; // already reported
  if (f.size < MIN_WASM_BYTES) {
    fail(f.rel, `only ${f.size} bytes — below the ${MIN_WASM_BYTES}-byte floor (truncated build?)`);
    return;
  }
  const bytes = readFileSync(f.abs);
  try {
    const info = inspectWasm(bytes);
    passes.push(`${f.rel} (${(f.size / 1024 / 1024).toFixed(2)} MB, ${info.exports} wasm exports)`);
  } catch (err) {
    fail(f.rel, err.message);
  }
}

function checkGlue(f, engine) {
  const gluePath = f.abs.replace(/\.wasm$/, '.js');
  const glueRel = f.rel.replace(/\.wasm$/, '.js');
  if (!existsSync(gluePath)) {
    fail(glueRel, `missing JS glue beside ${basename(f.rel)}`);
    return;
  }
  const glue = readFileSync(gluePath, 'utf8');
  if (glue.length === 0) return; // already reported by the zero-byte sweep
  // Same guard release.yml applies: engines ship single-threaded, and a
  // SharedArrayBuffer-backed memory will not instantiate in Android System
  // WebView (no crossOriginIsolated there).
  if (glue.includes('shared:true')) {
    fail(glueRel, 'contains shared:true — a threaded build leaked into the release');
  }
  // `callMain` is in EXPORTED_RUNTIME_METHODS, so it is in every glue emcc
  // emits for this project — including a broken one. `_main` is the signal
  // that the engine's entry point actually made it through the link.
  if (!/\b_main\b/.test(glue)) {
    fail(glueRel, 'no _main entry point in the glue — the engine did not link');
  }
  if (!LAZY_EXEMPT_ENGINES.has(engine)) {
    const missing = LAZY_EXPORTS.filter((sym) => !glue.includes(sym));
    if (missing.length > 0) {
      fail(
        glueRel,
        `missing lazy-FS export(s) ${missing.join(', ')} — stale build without scripts/wasmfs-lazy.c`,
      );
    }
  }
  if (failures.every((x) => x.file !== glueRel)) {
    passes.push(`${glueRel} (${glue.length} bytes)`);
  }
}

/**
 * Structural wasm check: magic, version, and a full walk of the section
 * framing (a truncated file trips the overrun check even when the first 64 KB
 * look fine). Returns the export count — a module with no exports cannot be
 * driven by the glue.
 */
function inspectWasm(bytes) {
  if (bytes.length < 8) throw new Error('shorter than a wasm header');
  if (!(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
    const got = [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    throw new Error(`bad wasm magic (expected 00 61 73 6d, got ${got})`);
  }
  const version = bytes.readUInt32LE(4);
  if (version !== 1) throw new Error(`unsupported wasm version ${version}`);

  let off = 8;
  let exports = null;
  while (off < bytes.length) {
    const id = bytes[off++];
    const sizeLeb = uleb(bytes, off);
    off = sizeLeb.next;
    const end = off + sizeLeb.value;
    if (end > bytes.length) throw new Error(`section ${id} overruns the file (truncated wasm)`);
    if (id === 7) exports = countExports(bytes, off, end);
    off = end;
  }
  if (exports === null) throw new Error('no export section');
  if (exports === 0) throw new Error('empty export section');
  return { version, exports };
}

function countExports(bytes, start, end) {
  let off = start;
  const count = uleb(bytes, off);
  off = count.next;
  for (let i = 0; i < count.value; i++) {
    const nameLen = uleb(bytes, off);
    off = nameLen.next + nameLen.value;
    if (off >= end) throw new Error('export section overruns its own bounds');
    off += 1; // kind
    const idx = uleb(bytes, off);
    off = idx.next;
  }
  return count.value;
}

function uleb(bytes, start) {
  let value = 0;
  let shift = 0;
  let off = start;
  for (;;) {
    if (off >= bytes.length) throw new Error('truncated LEB128 (corrupt wasm)');
    const byte = bytes[off++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('over-long LEB128 (corrupt wasm)');
  }
  return { value, next: off };
}

function readHead(path, n) {
  // Read the prefix only — TDS bundles can be hundreds of MB.
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Files of the unpacked TeX tree, when the caller points us at a dir holding one. */
function isTdsTreePath(rel) {
  return rel === 'texmf' || rel.startsWith('texmf/');
}

function walk(dir) {
  const out = [];
  (function rec(d) {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) rec(abs);
      else if (st.isFile()) {
        out.push({ abs, rel: relative(root, abs).split(sep).join('/'), size: st.size });
      }
    }
  })(dir);
  return out;
}
