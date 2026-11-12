#!/usr/bin/env node
import { createCompileSession, latexmk, createEngine } from '../dist/index.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const artifacts = fileURLToPath(new URL('../engine-artifacts/', import.meta.url));
const config = () => ({
  enginePath: join(artifacts, 'pdflatex/emscripten/pdflatex.wasm'),
  bundleUrl: join(artifacts, 'texmf-core-pdflatex.tar.gz'),
});
const session = createCompileSession({
  config,
  resourceVersion: 'pinned-review',
  maxLiveEngines: 1,
});
const handle = await createEngine('pdflatex', config());
const rows = [];
try {
  for (let i = 0; i < 6; i++) {
    const source =
      String.raw`\pdfinfoomitdate=1\pdftrailerid{}\pdfsuppressptexinfo=15\documentclass{article}\usepackage{amsmath}\begin{document}` +
      `Revision ${i}. ` +
      'The quick brown fox jumps over the lazy dog. '.repeat(240) +
      String.raw`\[x^2+y^2=z^2\]\end{document}`;
    const opts = {
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: source }],
    };
    let start = performance.now();
    const incremental = await session.compile(opts);
    const incrementalMs = performance.now() - start;
    start = performance.now();
    const clean = await latexmk({ ...opts, handles: { tex: handle } });
    const cleanMs = performance.now() - start;
    assert(incremental.success && clean.success);
    assert.equal(
      createHash('sha256').update(incremental.pdf).digest('hex'),
      createHash('sha256').update(clean.pdf).digest('hex'),
    );
    rows.push({
      revision: i,
      incrementalMs,
      incrementalPasses: incremental.passes,
      cleanMs,
      cleanPasses: clean.passes,
      pdfIdentical: true,
    });
  }
  console.log(JSON.stringify(rows, null, 2));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(rows, null, 2) + '\n');
} finally {
  await session.dispose();
  await handle.dispose();
}
