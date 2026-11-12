import {writeFile,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createEngine,latexmk} from '../../../dist/index.js';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const root=repo;
const out=process.env.REVIEW_OUTPUT || '/tmp/texlive-review-reproduction';
await mkdir(out,{recursive:true});
await writeFile(join(out,'package.json'),'{"type":"module"}');
for(const id of ['pdflatex','xelatex','lualatex','xdvipdfmx']){
 const dir=join(out,id);await mkdir(dir,{recursive:true});
 await symlink(join(root,'engine-artifacts',id,'emscripten',id+'.wasm'),join(dir,id+'.wasm')).catch(e=>{if(e.code!=='EEXIST')throw e;});
 await writeFile(join(dir,id+'.js'),`import factory from ${JSON.stringify(pathToFileURL(join(root,'engine-artifacts',id,'emscripten',id+'.js')).href)};export default async function(opts){const start=performance.now();const mod=await factory(opts);const ready=performance.now();const call=mod.callMain.bind(mod);mod.callMain=(args)=>{const t=performance.now();try{return call(args);}finally{opts.printErr('BENCH:'+JSON.stringify({factoryMs:ready-start,setupMs:t-ready,callMainMs:performance.now()-t,heapBytes:mod.HEAPU8.byteLength}));}};return mod;}`);
}
const body=String.raw`\documentclass{article}\usepackage{amsmath}\begin{document}`+
Array.from({length:30},(_,i)=>`Paragraph ${i}. The quick brown fox jumps over the lazy dog. `.repeat(8)+'\n\n').join('')+String.raw`\[\int_0^1 x^2\,dx=\frac13\]\end{document}`;
const rows=[];
for(const entry of [
 {id:'pdflatex',tier:'core',lazy:true},{id:'pdflatex',tier:'core',lazy:false},
 {id:'pdflatex',tier:'full',lazy:true},{id:'xelatex',tier:'core',lazy:true,reuse:false},
 {id:'xelatex',tier:'core',lazy:true,reuse:true},{id:'lualatex',tier:'core',lazy:true}
]){
 const config=(id)=>({enginePath:join(out,id,id+'.wasm'),bundleUrl:join(root,'engine-artifacts',entry.tier==='full'?'texmf.tar.gz':`texmf-core-${entry.id}.tar.gz`),lazyTds:entry.lazy,...(id==='xelatex'?{icuDataUrl:join(root,'engine-artifacts/icudt78l.dat')}:{})});
 const started=performance.now();const tex=await createEngine(entry.id,config(entry.id));
 const helper=entry.reuse?await createEngine('xdvipdfmx',config('xdvipdfmx')):undefined;
 const initMs=performance.now()-started;
 try {
  const samples=[];
  for(let i=0;i<3;i++){
   const t=performance.now();const r=await latexmk({engine:entry.id,mainTex:'main.tex',files:[{path:'main.tex',content:body}],handles:{tex,...(helper?{xdvipdfmx:helper}:{})},engineConfig:config,timeoutMs:120000});
   if(!r.success)throw new Error(r.log);
   const stages=r.logs.flatMap(log=>log.stderr.split('\n').filter(s=>s.startsWith('BENCH:')).map(s=>({cmd:log.cmd,...JSON.parse(s.slice(6))})));
   samples.push({wallMs:performance.now()-t,passes:r.passes,pdfBytes:r.pdf.length,stages});
  }
  const row={...entry,initMs,samples,rssBytes:process.memoryUsage().rss};rows.push(row);
  console.log(JSON.stringify({id:entry.id,tier:entry.tier,lazy:entry.lazy,reuse:entry.reuse,initMs:Math.round(initMs),wallMs:samples.map(s=>Math.round(s.wallMs)),stages:samples[2].stages.map(s=>({cmd:s.cmd,factoryMs:Math.round(s.factoryMs),setupMs:Math.round(s.setupMs),callMainMs:Math.round(s.callMainMs),heapMiB:Math.round(s.heapBytes/1048576)}))}));
 }finally{await tex.dispose();await helper?.dispose();}
}
await writeFile(join(out,'benchmark.json'),JSON.stringify(rows,null,2));
