// Smoke test for the generated wasm bindings.
//
//   ./build-wasm.sh && node wasm-smoke.mjs
//
// Loads ./pkg/texlive_wasm.js, instantiates the module synchronously from the
// .wasm bytes, and exercises the JS-facing API end to end.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initSync } from './pkg/texlive_wasm.js';
import * as m from './pkg/texlive_wasm.js';

const here = dirname(fileURLToPath(import.meta.url));
initSync({ module: readFileSync(join(here, 'pkg/texlive_wasm_bg.wasm')) });

const assert = (cond, msg) => {
  if (cond) {
    console.log('ok:', msg);
  } else {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  }
};

assert(m.safeRelativePath('a/b/c.tex') === 'a/b/c.tex', 'safeRelativePath keeps safe path');
assert(m.safeRelativePath('../etc/passwd') === undefined, 'safeRelativePath rejects traversal');
assert(m.safeResolve('/project', 'a/b') === '/project/a/b', 'safeResolve joins');
assert(m.safeResolve('/project', '/projectile') === undefined, 'safeResolve rejects sibling prefix');

assert(
  m.sha256Hex(new Uint8Array([0x61])) ===
    'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
  'sha256("a")',
);

const lsr = m.buildLsR(['tex/latex/base/article.cls', 'tex/latex/base/size10.clo']);
assert(lsr.includes('./tex/latex/base:'), 'ls-R groups by directory');
assert(lsr.includes('article.cls'), 'ls-R lists filename');

assert(
  m.tdsRelative('/texmf-dist/tex/latex/base/article.cls') === 'tex/latex/base/article.cls',
  'tdsRelative strips root',
);

assert(
  JSON.stringify(m.parseMissingFiles('! LaTeX Error: File `foo.sty\' not found.')) === '["foo.sty"]',
  'parseMissingFiles',
);

const manifest = m.Manifest.fromJson(
  JSON.stringify({
    schema: 1,
    version: 'texlive-2026-r0',
    generatedAt: '2026-01-01T00:00:00Z',
    files: {
      'tex/latex/base/article.cls': {
        sha256: 'a'.repeat(64),
        size: 1,
        tier: 'core',
        package: 'base',
      },
    },
  }),
);
assert(manifest.tierOf('tex/latex/base/article.cls') === 'core', 'Manifest.tierOf');
assert(manifest.fileCount() === 1, 'Manifest.fileCount');
manifest.free();

assert(
  JSON.stringify(m.engineArgs('pdflatex', JSON.stringify({ mainTex: 'main.tex' }))) ===
    JSON.stringify([
      '--no-shell-escape',
      '--interaction=nonstopmode',
      '--halt-on-error',
      '--output-format=pdf',
      'main.tex',
    ]),
  'engineArgs pdflatex',
);

const files = JSON.stringify([
  {
    path: 'main.tex',
    content: '\\usepackage[backend=biber]{biblatex}\\bibliography{refs}',
  },
]);
assert(m.willRunBibtex(files) === false, 'willRunBibtex false for biber doc');
assert(m.willRunBiber(files) === true, 'willRunBiber true for biber doc');

assert(m.projectPaths('sub/main.tex').pdf === 'main.pdf', 'projectPaths basename');
assert(m.maxPasses('"auto"', true) === 5, 'maxPasses biblatex');

console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE OK');
