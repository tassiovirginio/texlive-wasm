/** Compile original and opt-in external corpora; verify text, pages and embedded fonts. */
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createCompileSession, analyzeProject } from '../dist/index.js';
const repo = fileURLToPath(new URL('..', import.meta.url)),
  artifacts = join(repo, 'engine-artifacts');
const config = (id) => ({
  enginePath: join(artifacts, id, 'emscripten', id + '.wasm'),
  bundleUrl: join(artifacts, id === 'biber' ? 'biber/emscripten/biber-vfs.tar.gz' : 'texmf.tar.gz'),
  ...(id === 'xelatex' || id === 'bibtexu' ? { icuDataUrl: join(artifacts, 'icudt78l.dat') } : {}),
});
const session = createCompileSession({
  config,
  resourceVersion: 'original-corpus',
  maxLiveEngines: 3,
});
const temp = await mkdtemp(join(tmpdir(), 'texlive-corpus-'));
const results = [];
async function inputs(root, dir = '') {
  const list = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const p = dir ? dir + '/' + entry.name : entry.name;
    if (entry.isDirectory()) list.push(...(await inputs(root, p)));
    else if (entry.isFile()) list.push({ path: p, content: await readFile(join(root, p)) });
  }
  return list;
}
const cases = [
  {
    id: 'article',
    main: 'main.tex',
    engine: 'pdflatex',
    pages: 1,
    text: ['Original article regression', 'Original Corpus Reference'],
  },
  {
    id: 'report',
    main: 'main.tex',
    engine: 'pdflatex',
    pages: 3,
    text: ['Original chapter alpha', 'Original chapter beta'],
  },
  {
    id: 'slides',
    main: 'main.tex',
    engine: 'pdflatex',
    pages: 2,
    text: ['First original slide', 'Second original slide'],
  },
];
if (process.argv[2])
  for (const spec of JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))) cases.push(spec);
try {
  for (const spec of cases) {
    const root = spec.root ? resolve(spec.root) : join(repo, 'test/fixtures/corpus', spec.id);
    const files = await inputs(root);
    const analysis = analyzeProject(files, spec.main);
    assert(
      !analysis.problems.some((p) => p.severity === 'error'),
      JSON.stringify(analysis.problems),
    );
    const start = performance.now();
    const r = await session.compile({
      engine: spec.engine,
      mainTex: spec.main,
      files,
      strict: true,
      preflight: true,
      timeoutMs: 180000,
    });
    assert(r.success, spec.id + ': ' + r.log + '\n' + JSON.stringify(r.diagnostics));
    const pdf = join(temp, spec.id.replace(/[^a-z0-9-]/gi, '_') + '.pdf');
    await writeFile(pdf, r.pdf);
    const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
    for (const expected of spec.text ?? [])
      assert(text.includes(expected), spec.id + ': missing ' + expected);
    const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
    if (spec.pages) assert.match(info, new RegExp('Pages:\\s+' + spec.pages + '\\b'));
    const fonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' })
      .split('\n')
      .slice(2)
      .filter((s) => s.trim());
    assert(fonts.length > 0, 'No fonts embedded');
    for (const row of fonts)
      assert.match(
        row,
        /\s+yes\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/,
        'Unembedded font: ' + row,
      );
    if (spec.referencePdf) {
      const reference = resolve(spec.referencePdf);
      const bbox = path => execFileSync('pdftotext', ['-bbox', path, '-'], {encoding:'utf8'}).match(/<word[^>]*>[^<]*<\/word>/g) ?? [];
      assert.deepEqual(bbox(pdf), bbox(reference), spec.id + ': text geometry changed');
      const prefix = spec.id.replace(/[^a-z0-9-]/gi, '_');
      execFileSync('pdftoppm', ['-r','144',pdf,join(temp,prefix+'-actual')]);
      execFileSync('pdftoppm', ['-r','144',reference,join(temp,prefix+'-reference')]);
      const pages = (await readdir(temp)).filter(p=>p.startsWith(prefix+'-actual-')&&p.endsWith('.ppm')).sort();
      const references = (await readdir(temp)).filter(p=>p.startsWith(prefix+'-reference-')&&p.endsWith('.ppm')).sort();
      assert.equal(pages.length,references.length,'Reference page count changed');
      for(let i=0;i<pages.length;i++) assert.deepEqual(await readFile(join(temp,pages[i])),await readFile(join(temp,references[i])),spec.id+': rendered page differs');
    }
    results.push({
      id: spec.id,
      engine: spec.engine,
      passes: r.passes,
      pdfBytes: r.pdf.length,
      durationMs: performance.now() - start,
    });
    console.log('PASS corpus ' + spec.id);
    session.clear();
  }
  if (process.env.CORPUS_OUTPUT)
    await writeFile(process.env.CORPUS_OUTPUT, JSON.stringify(results, null, 2) + '\n');
} finally {
  await session.dispose();
  await rm(temp, { recursive: true, force: true });
}
