/** Real regressions for optional families, partial builds, previews and delta transport. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  createCompileSession,
  createEngine,
  refineSynctex,
  createSynctex,
  loadPackageIndex,
  createHttpPackageFs,
} from '../dist/index.js';
const artifacts = fileURLToPath(new URL('../engine-artifacts/', import.meta.url));
const catalog = JSON.parse(await readFile(join(artifacts, 'font-packs.json'), 'utf8'));
const config = (id) => ({
  enginePath: join(artifacts, id, 'emscripten', id + '.wasm'),
  bundleUrl: join(artifacts, 'texmf-core-pdflatex.tar.gz'),
});
const session = createCompileSession({
  config,
  resourceVersion: 'features',
  maxLiveEngines: 2,
  fontCatalog: { catalog, baseUrl: new URL('../engine-artifacts/', import.meta.url).href },
});
const temp = await mkdtemp(join(tmpdir(), 'texlive-features-'));
const text = async (pdf) => {
  const p = join(temp, 'out.pdf');
  await writeFile(p, pdf);
  return execFileSync('pdftotext', [p, '-'], { encoding: 'utf8' });
};
try {
  for (const [name, preamble] of [
    [
      'psnfss',
      String.raw`\usepackage{courier,helvet,mathptmx}\renewcommand\familydefault{\ttdefault}`,
    ],
    ['libertine', String.raw`\usepackage{libertine}`],
    ['newtx', String.raw`\usepackage{newtxtext,newtxmath}`],
    ['inconsolata', String.raw`\usepackage{inconsolata}\renewcommand\familydefault{\ttdefault}`],
    ['montserrat', String.raw`\usepackage[defaultfam]{montserrat}`],
    ['noto', String.raw`\usepackage[sf,sfdefault,nott]{noto}`],
    ['tex-gyre', String.raw`\usepackage{tgtermes}`],
  ]) {
    const source =
      String.raw`\documentclass{article}\usepackage[T1]{fontenc}` +
      preamble +
      String.raw`\begin{document}Exact family font test. $a+b=c$\end{document}`;
    const r = await session.compile({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: source }],
      strict: true,
      timeoutMs: 120000,
    });
    assert(r.success, name + ': ' + r.log + JSON.stringify(r.logs) + '\n' + JSON.stringify(r.diagnostics));
    assert.match(await text(r.pdf), /Exact family font test/);
    const fontList = execFileSync('pdffonts', [join(temp, 'out.pdf')], {encoding:'utf8'});
    const exact = {psnfss:/Nimbus|Courier/,libertine:/LinLibertine/,newtx:/TeXGyreTermes|NewTX|txr/,inconsolata:/Inconsolata/,montserrat:/Montserrat/,noto:/NotoSans/,'tex-gyre':/TeXGyreTermes/};
    assert.match(fontList, exact[name], name+': expected font absent');
    assert(!fontList.includes('Type 3'), name+': bitmap font');
    console.log('PASS exact family ' + name);
  }
  for (const engine of ['xelatex', 'lualatex']) {
    const unicode = createCompileSession({
      resourceVersion:'unicode-fonts',maxLiveEngines:2,
      config:id=>({...config(id),bundleUrl:join(artifacts,`texmf-core-${engine}.tar.gz`),...(id==='xelatex'?{icuDataUrl:join(artifacts,'icudt78l.dat')}:{})}),
      fontCatalog:{catalog,baseUrl:new URL('../engine-artifacts/',import.meta.url).href},
    });
    try {
      const r=await unicode.compile({engine,mainTex:'main.tex',files:[{path:'main.tex',content:String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{`+(engine==='lualatex'?'texgyretermes-regular.otf':'TeX Gyre Termes')+String.raw`}\begin{document}Exact Unicode family font test.\end{document}`}],strict:true,timeoutMs:120000});
      assert(r.success,engine+': '+r.log+JSON.stringify(r.logs));
      assert.match(await text(r.pdf),/Exact Unicode family font test/);
      console.log('PASS exact optional fonts '+engine);
    } finally {await unicode.dispose();}
  }
  const sources = [
    {
      path: 'main.tex',
      content: String.raw`\pdfinfoomitdate=1\pdftrailerid{}\pdfsuppressptexinfo=15\documentclass{report}\begin{document}\include{chapters/a}\include{chapters/b}\end{document}`,
    },
    { path: 'chapters/a.tex', content: String.raw`\chapter{Alpha}ALPHA BODY` },
    { path: 'chapters/b.tex', content: String.raw`\chapter{Beta}BETA BODY` },
  ];
  let previewCount = 0;
  const full = await session.compile({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: sources,
    synctex: true,
    preview: true,
    onEvent: (e) => {
      if (e.type === 'preview') previewCount++;
    },
    strict: true,
  });
  assert(full.success, full.log);
  assert(previewCount > 0);
  assert.match(await text(full.pdf), /BETA BODY/);
  const partial = await session.compile({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: sources,
    includeOnly: ['chapters/a'],
    strict: true,
  });
  assert(partial.success, partial.log);
  assert(partial.partial);
  assert(!partial.complete);
  assert.doesNotMatch(await text(partial.pdf), /BETA BODY/);
  const after = await session.compile({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: sources,
    strict: true,
  });
  assert(after.success, after.log);
  assert.equal(
    createHash('sha256').update(full.pdf).digest('hex'),
    createHash('sha256').update(after.pdf).digest('hex'),
  );
  const sync = await createSynctex(full.synctex);
  assert(sync.forward('chapters/a.tex', 1).length > 0);
  assert.equal(
    refineSynctex(sources, 'ALPHA BODY', { preferred: { file: 'class.cls', line: 100, column: 0 } })
      .file,
    'chapters/a.tex',
  );
  console.log('PASS partial/full isolation, previews and source navigation');
  const indexBytes = await readFile(join(artifacts, 'texlive-package-index.json'));
  const index = await loadPackageIndex(new URL('../engine-artifacts/texlive-package-index.json', import.meta.url).href, createHash('sha256').update(indexBytes).digest('hex'));
  const provider = createHttpPackageFs({index, version:'tl2023-final', baseUrl:new URL('../engine-artifacts/font-source/', import.meta.url).href});
  const dynamic = await createEngine('pdflatex', {...config('pdflatex'), vfs: [provider]});
  try {
    const r = await dynamic.run({args:['--interaction=nonstopmode','--halt-on-error','main.tex'],files:[{path:'main.tex',content:String.raw`\documentclass{article}\usepackage{fontaxes}\begin{document}Verified package resolution\end{document}`}]});
    assert.equal(r.exitCode,0,r.log); assert(r.lazyFetchRetries > 0);
    assert.match(await text(r.outputs.get('main.pdf')),/Verified package resolution/);
    console.log('PASS verified package resolution with real XZ archive');
  } finally { await dynamic.dispose(); }
  const handle = await createEngine('pdflatex', config('pdflatex'));
  try {
    const files = [
      {
        path: 'main.tex',
        content: String.raw`\documentclass{article}\begin{document}Delta file transport\end{document}`,
      },
      { path: 'large.bin', content: new Uint8Array(1024 * 1024).fill(17) },
    ];
    const first = await handle.run({
      args: ['--interaction=nonstopmode', '--halt-on-error', 'main.tex'],
      files,
    });
    const second = await handle.run({
      args: ['--interaction=nonstopmode', '--halt-on-error', 'main.tex'],
      files,
    });
    assert.equal(first.exitCode, 0, first.log);
    assert.equal(second.exitCode, 0, second.log);
    assert(second.inputTransport.reusedBytes >= 1024 * 1024);
    assert.equal(second.inputTransport.sentBytes, 0);
    console.log('PASS cached worker transport:', JSON.stringify(second.inputTransport));
  } finally {
    await handle.dispose();
  }
} finally {
  await session.dispose();
  await rm(temp, { recursive: true, force: true });
}
