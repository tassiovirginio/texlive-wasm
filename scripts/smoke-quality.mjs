#!/usr/bin/env node
/** Real-engine content regressions; requires built dist, bundles and Poppler. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createEngine, latexmk, createCompileSession } from '../dist/index.js';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(repo, 'engine-artifacts');
const pack = async (name) => {
  const url = join(artifacts, `texmf-pack-${name}.tar.gz`);
  return {
    url,
    sha256: createHash('sha256')
      .update(await readFile(url))
      .digest('hex'),
  };
};
const portuguese = await pack('portuguese');
const config = (id) => ({
  enginePath: join(artifacts, id, 'emscripten', id + '.wasm'),
  bundleUrl: join(artifacts, 'texmf.tar.gz'),
  resourcePacks: [portuguese],
  ...(id === 'xelatex' ? { icuDataUrl: join(artifacts, 'icudt78l.dat') } : {}),
});
const temp = await mkdtemp(join(tmpdir(), 'texlive-quality-'));
const session = createCompileSession({ config, resourceVersion: 'quality-v1', maxLiveEngines: 2 });
const textOf = async (bytes) => {
  const path = join(temp, 'output.pdf');
  await writeFile(path, bytes);
  return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
};
const compile = async (name, source, extra = {}) => {
  const r = await session.compile({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: [{ path: 'main.tex', content: source }],
    timeoutMs: 120000,
    ...extra,
  });
  assert(r.success, `${name}: ${r.log}\n${JSON.stringify(r.diagnostics)}`);
  assert(r.complete, `${name}: incomplete PDF`);
  console.log(`PASS ${name} (${r.passes} passes)`);
  return r;
};
try {
  const portugueseDoc = String.raw`\documentclass{abntex2}\usepackage[T1]{fontenc}\usepackage{lmodern}\usepackage[brazil]{babel}\begin{document}\typeout{PT-LANG=\number\language}Informação em português: ação, café.\end{document}`;
  let r = await compile('Portuguese/ABNT', portugueseDoc);
  assert.match((await textOf(r.pdf)).normalize('NFC'), /português/);
  assert.match(r.log, /PT-LANG=[1-9][0-9]*/);
  assert(!r.log.includes('No hyphenation patterns'));
  const coreHandle = await createEngine('pdflatex', {
    ...config('pdflatex'),
    bundleUrl: join(artifacts, 'texmf-core-pdflatex.tar.gz'),
  });
  try {
    const coreResult = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: portugueseDoc }],
      handles: { tex: coreHandle },
      strict: true,
    });
    assert(coreResult.success, coreResult.log);
    console.log('PASS ABNT dependencies with minimal core');
  } finally {
    await coreHandle.dispose();
  }
  r = await compile(
    'named indexes',
    String.raw`\documentclass{article}\usepackage{imakeidx}\makeindex[name=people,title=People]\makeindex[name=places,title=Places]\begin{document}Alice\index[people]{Alice} Bahia\index[places]{Bahia}\printindex[people]\printindex[places]\end{document}`,
  );
  assert(r.logs.some((l) => l.cmd === 'makeindex people.idx'));
  assert(r.logs.some((l) => l.cmd === 'makeindex places.idx'));
  const indexed = await textOf(r.pdf);
  assert.match(indexed, /People/);
  assert.match(indexed, /Places/);
  r = await compile(
    'glossary and acronyms',
    String.raw`\documentclass{article}\usepackage[acronym]{glossaries}\makeglossaries\newglossaryentry{api}{name=API,description={application interface}}\newacronym{cpu}{CPU}{central processing unit}\begin{document}\gls{api} and \gls{cpu}.\printglossaries\end{document}`,
  );
  assert.match(await textOf(r.pdf), /application interface/);
  assert(r.logs.some((l) => l.cmd === 'makeindex main.glo'));
  assert(r.logs.some((l) => l.cmd === 'makeindex main.acn'));
  r = await compile(
    'reproducible date',
    String.raw`\documentclass{article}\begin{document}\typeout{REPRO-YEAR=\number\year}\today\end{document}`,
    { processEnv: { SOURCE_DATE_EPOCH: '946684800', FORCE_SOURCE_DATE: '1' } },
  );
  assert.match(r.log, /REPRO-YEAR=2000/);
  const fixture = await readFile(join(repo, 'docs/analysis/2026-11-12/fidelity.tex'), 'utf8');
  r = await compile('native reference fidelity', fixture);
  assert.equal(
    createHash('sha256').update(r.pdf).digest('hex'),
    '20319d511ca5b404001435144b7f3ae93238f212b8bcb616c090502fe91c1405',
  );
  const missing = await session.compile({
    engine: 'lualatex',
    mainTex: 'main.tex',
    files: [
      {
        path: 'main.tex',
        content: String.raw`\documentclass{article}\begin{document}Hello 中文\end{document}`,
      },
    ],
    strict: true,
    timeoutMs: 120000,
  });
  assert.equal(missing.success, false);
  assert(missing.pdf);
  assert(missing.diagnostics.some((d) => d.code === 'missing-character'));
  console.log('PASS missing glyph strict failure');
  const multilingual = await pack('multilingual');
  const xe = await createEngine('xelatex', { ...config('xelatex'), resourcePacks: [multilingual] });
  try {
    const source = String.raw`\documentclass{article}\usepackage{fontspec}\usepackage{polyglossia}\setdefaultlanguage{english}\setotherlanguage{arabic}\newfontfamily\arabicfont{Noto Naskh Arabic}\newfontfamily\cjkfont{Noto Sans CJK SC}\begin{document}Hello {\cjkfont 中文 日本語 한국어} \textarabic{مرحبا بالعالم}\end{document}`;
    const rr = await latexmk({
      engine: 'xelatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: source }],
      handles: { tex: xe },
      engineConfig: (id) => ({ ...config(id), resourcePacks: [multilingual] }),
      strict: true,
      timeoutMs: 120000,
    });
    assert(
      rr.success,
      rr.log +
        '\n' +
        JSON.stringify(rr.diagnostics) +
        '\n' +
        rr.logs.map((l) => l.stderr).join('\n'),
    );
    assert.match(await textOf(rr.pdf), /中文/);
    console.log('PASS multilingual shaping and font pack');
  } finally {
    await xe.dispose();
  }
  const alias = await createEngine('pdflatex', config('pdflatex'));
  try {
    const rr = await alias.run({
      args: ['--fmt=latex', '--interaction=nonstopmode', '--halt-on-error', 'main.tex'],
      files: [
        {
          path: 'main.tex',
          content: String.raw`\documentclass{article}\begin{document}DVI mode\end{document}`,
        },
      ],
    });
    assert.equal(rr.exitCode, 0, rr.log);
    assert(rr.outputs.has('main.dvi'));
    console.log('PASS rebuilt latex format');
  } finally {
    await alias.dispose();
  }
} finally {
  await session.dispose();
  await rm(temp, { recursive: true, force: true });
}
