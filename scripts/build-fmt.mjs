#!/usr/bin/env node
/**
 * build-fmt.mjs — generate pdflatex.fmt with our wasm pdflatex.
 *
 * Run AFTER `bash scripts/fetch-tds.sh` populates the TDS.
 *
 * Output: engine-artifacts/texmf/web2c/pdftex/pdflatex.fmt
 *
 * Why: the .fmt file is tightly coupled to the executable that built it
 * (string-pool offsets etc.). Ubuntu's apt-shipped .fmt is for Ubuntu's
 * pdflatex; ours rejects it with "made by different executable version".
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');
const PDFLATEX_JS = join(REPO_ROOT, 'engine-artifacts/pdflatex/emscripten/pdflatex.js');

if (!statSync(TEXMF, { throwIfNoEntry: false })) {
  console.error('Run scripts/fetch-tds.sh first to populate', TEXMF);
  process.exit(1);
}

// import() takes a URL, not a path: a bare absolute path works on POSIX but
// the ESM loader rejects "C:\..." as an unknown scheme.
const m = await import(pathToFileURL(PDFLATEX_JS).href);

function walk(FS, absDir, mfsDir) {
  if (!FS.analyzePath(mfsDir).exists) FS.mkdir(mfsDir);
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const mfs = mfsDir + '/' + name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(FS, abs, mfs);
    else if (st.isFile()) {
      try {
        FS.writeFile(mfs, readFileSync(abs));
      } catch {}
    }
  }
}

for (const format of ['pdflatex', 'latex']) {
  const Module = await m.default({
    noInitialRun: true,
    thisProgram: '/bin/pdflatex',
    print: (t) => process.stdout.write(t + '\n'),
    printErr: (t) => process.stderr.write(t + '\n'),
  });

  walk(Module.FS, TEXMF, '/texmf-dist');
  Module.FS.mkdir('/bin');
  Module.FS.writeFile('/bin/pdflatex', new Uint8Array());
  Module.FS.mkdir('/work');
  Module.FS.chdir('/work');

  console.error('[build-fmt] building pdflatex.fmt with wasm pdflatex...');
  const t0 = Date.now();
  let exitCode;
  try {
    exitCode = Module.callMain([
      '-ini',
      '-etex',
      '-interaction=nonstopmode',
      `-jobname=${format}`,
      '-output-format=dvi',
      '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
      '-cnf-line=TEXMF=/texmf-dist',
      '-cnf-line=TEXMFDIST=/texmf-dist',
      '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
      '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
      `/texmf-dist/tex/latex/tex-ini-files/${format}.ini`,
    ]);
  } catch (e) {
    exitCode = e?.status ?? -1;
  }
  console.error(`[build-fmt] exit=${exitCode} in ${Date.now() - t0}ms`);

  // The .fmt existing is not proof of a good build: -interaction=nonstopmode
  // carries on past errors and still dumps a format made from a half-loaded
  // latex.ltx, which then fails at compile time on a user's machine. Gate on the
  // engine's exit status and on the log the engine actually wrote.
  const log = readLog(Module, `/work/${format}.log`);
  const problems = [];
  if (exitCode !== 0) problems.push(`engine exited with ${exitCode}`);
  problems.push(...fatalMarkers(log));
  if (!Module.FS.analyzePath(`/work/${format}.fmt`).exists) problems.push('no fmt produced');

  if (problems.length > 0) {
    console.error('[build-fmt] FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    if (log) console.error(log.slice(-2000));
    process.exit(1);
  }

  const fmt = Module.FS.readFile(`/work/${format}.fmt`);
  const outPath = join(TEXMF, `web2c/pdftex/${format}.fmt`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, fmt);
  console.error(`[build-fmt] wrote ${outPath} (${fmt.length} bytes)`);
}

function readLog(mod, path) {
  if (!mod.FS.analyzePath(path).exists) return '';
  return new TextDecoder().decode(mod.FS.readFile(path));
}

/** TeX's own fatal vocabulary — an error line, a stop, an abort. */
function fatalMarkers(text) {
  if (!text) return [];
  const found = [];
  const error = text.match(/^! .*$/m);
  if (error) found.push(`TeX error in the log: ${error[0].trim()}`);
  if (text.includes('Emergency stop')) found.push('Emergency stop in the log');
  if (text.includes('Fatal error occurred')) found.push('fatal error in the log');
  return found;
}
