import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
import { createRequire } from 'node:module';
import { createEngine, latexmk } from '../dist/index.js';
import { createNodeEngine } from '../dist/node.js';
const root = await mkdtemp(join(tmpdir(), 'texlive-node-'));
const enginePath = join(root, 'engine.wasm');
// This is a transport/runtime fixture, not a TeX engine. Real TeX smoke is separate.
const glue = `export default async function(opts) {
  const dirs = new Set(['/']); const files = new Map();
  const FS = {
    mkdir(p) { dirs.add(p); }, writeFile(p,b) { files.set(p,typeof b==='string'?new TextEncoder().encode(b):b); },
    readFile(p) { if(!files.has(p)) throw new Error('ENOENT'); return files.get(p).slice(); },
    stat(p) { if(dirs.has(p)) return {mode:0o40755,size:0}; if(files.has(p)) return {mode:0o100644,size:files.get(p).length}; throw new Error('ENOENT'); },
    readdir(p) { const prefix=p+'/'; return ['.','..',...new Set([...dirs,...files.keys()].filter(x=>x.startsWith(prefix)).map(x=>x.slice(prefix.length).split('/')[0]).filter(Boolean))]; },
    chdir() {}, unlink(p) {files.delete(p);}
  };
  return {FS, ENV:{}, HEAPU8:new Uint8Array(4096), HEAPU32:new Uint32Array(1024), _malloc(){return 8;}, _free(){},
    callMain(args) {
      if(args.includes('hang')) {while(true) {}}
      FS.writeFile('/project/main.pdf','%PDF-1.5 transport fixture');
      FS.writeFile('/project/main.aux','stable'); FS.writeFile('/project/main.log','ok');
      opts.print('worker stdout'); return 0;
    }
  };
}`;
await writeFile(join(root, 'engine.js'), glue);
await writeFile(join(root, 'package.json'), '{"type":"module"}');
const config = {enginePath, vfs:[{id:'test', list:()=>['web2c/pdftex/pdflatex.fmt'], read:()=>new TextEncoder().encode('FMT')}]};
const tar = Buffer.alloc(2048);
tar.write('texmf/web2c/pdftex/pdflatex.fmt'); tar.write('00000000003\0',124); tar[156]=48;tar.write('ustar\0',257);tar.write('FMT',512);
await writeFile(join(root,'core.tar'),tar);
await writeFile(join(root,'manifest.json'),JSON.stringify({schema:1,version:'fixture',generatedAt:'2026-01-01T00:00:00Z',coreBundleUrl:'core.tar',coreBundleSha256:createHash('sha256').update(tar).digest('hex'),fullBundleUrl:null,cdnBaseUrl:null,files:{}}));
try {
  for (const create of [createEngine, createNodeEngine, createRequire(import.meta.url)('../dist/index.cjs').createEngine]) {
    const handle = await create('pdflatex', config);
    try {
      const result = await latexmk({engine:'pdflatex',mainTex:'main.tex', files:[{path:'main.tex',content:'hello'}],handles:{tex:handle}});
      assert.equal(result.success,true); assert.equal(result.converged,true); assert.equal(result.passes,2);
      assert.match(new TextDecoder().decode(result.pdf), /^%PDF/);
      assert.match(result.logs[0].stdout, /worker stdout/);
      await assert.rejects(handle.run({args:['hang'], timeoutMs:50}), /exceeded/);
      assert.equal(handle.isReady(),false);
    } finally {await handle.dispose();}
  }
  const local = await createEngine('pdflatex',{enginePath,manifestUrl:join(root,'manifest.json')});
  try {assert.equal((await local.run({args:['main.tex']})).exitCode,0);} finally {await local.dispose();}
  console.log('Node worker transport: ES, CJS, orchestration and timeout passed');
} finally { await rm(root,{recursive:true,force:true}); }
