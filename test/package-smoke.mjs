/** Verify the shipped npm tarball, CLI extraction and a real compile after installation. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const release=resolve('release');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const root=await mkdtemp(join(tmpdir(),'texlive-installed-'));
try {
  await writeFile(join(root,'package.json'),'{"private":true,"type":"module"}');
  execFileSync('npm',['install','--prefix',root,'--no-audit','--no-fund',join(release,`typeward-texlive-wasm-${pkg.version}.tgz`)],{stdio:'pipe'});
  const installed=join(root,'node_modules/@typeward/texlive-wasm');
  const preload=join(root,'mock-release.cjs');
  await writeFile(preload,`const fs=require('node:fs');const path=require('node:path');globalThis.fetch=async(url)=>{const name=new URL(url).pathname.split('/').pop();const file=path.join(process.env.TEXLIVE_RELEASE_DIR,name);return fs.existsSync(file)?new Response(fs.readFileSync(file)):new Response(null,{status:404});};`);
  const assets=join(root,'assets');
  execFileSync(process.execPath,['--require',preload,join(installed,'scripts/cli.cjs'),'download-assets','--assets','pdflatex-emscripten,texmf-core-pdflatex,tex-packages-pdflatex.json,font-packs.json,texmf-font-inconsolata',assets],{env:{...process.env,TEXLIVE_RELEASE_DIR:release},stdio:'pipe'});
  assert.deepEqual(await readFile(join(assets,'texmf-font-inconsolata.tar.gz')), await readFile(join(release,'texmf-font-inconsolata.tar.gz')));
  assert.equal(JSON.parse(await readFile(join(assets,'font-packs.json'),'utf8')).version,pkg.version);
  const {createEngine,latexmk}=await import(pathToFileURL(join(installed,'dist/index.js')).href);
  const handle=await createEngine('pdflatex',{enginePath:join(assets,'pdflatex/emscripten/pdflatex.wasm'),manifestUrl:join(assets,'tex-packages-pdflatex.json')});
  try {
    const result=await latexmk({engine:'pdflatex',mainTex:'main.tex',files:[{path:'main.tex',content:String.raw`\documentclass{article}\begin{document}Installed package verified.\end{document}`}],handles:{tex:handle}});
    assert.equal(result.success,true,result.log);assert.ok(result.pdf.length>1000);
    console.log(`Installed ${pkg.version}: CLI checksums/extraction, manifest integrity and real PDF passed`);
  }finally{await handle.dispose();}
}finally{await rm(root,{recursive:true,force:true});}
