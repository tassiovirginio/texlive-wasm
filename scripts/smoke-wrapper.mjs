/** Real TeX smoke through the published API (distinct from the transport fixtures). */
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createEngine,latexmk,createSynctex} from '../dist/index.js';
const root=resolve('engine-artifacts');
const id=process.argv[2]??'pdflatex';
const before=process.memoryUsage().rss;
const handle=await createEngine(id,{
  enginePath:join(root,id,'emscripten',`${id}.wasm`),
  bundleUrl:join(root,`texmf-core-${id}.tar.gz`),
  ...(id==='xelatex'?{icuDataUrl:join(root,'icudt78l.dat')}:{}),
});
try {
  const result=await latexmk({engine:id,mainTex:'main.tex',files:[{path:'main.tex',content:String.raw`\documentclass{article}\begin{document}Hello from the public wrapper.\end{document}`}],handles:{tex:handle},synctex:true,timeoutMs:120000,
    engineConfig:(helper)=>({enginePath:join(root,helper,'emscripten',`${helper}.wasm`),bundleUrl:join(root,`texmf-core-${id}.tar.gz`)})});
  assert.equal(result.success,true,result.log);
  assert.equal(result.converged,true);
  assert.match(new TextDecoder().decode(result.pdf.subarray(0,8)),/^%PDF-/);
  assert.ok(result.synctex?.length);
  await writeFile(join(root,`wrapper-${id}.synctex.gz`),result.synctex);
  const lookup=await createSynctex(result.synctex);
  assert.ok(lookup.forward('main.tex',1).length,'SyncTeX must locate the source line');
  await writeFile(join(root,`wrapper-${id}.pdf`),result.pdf);
  const report={engine:id,passes:result.passes,pdfBytes:result.pdf.length,rssBefore:before,rssAfter:process.memoryUsage().rss};
  await writeFile(join(root,`wrapper-${id}-metrics.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await handle.dispose();}
