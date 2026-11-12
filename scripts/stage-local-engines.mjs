/** Stage engines built by engine/Makefile in the layout used by the smoke/release tools. */
import {mkdir,copyFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
for(const engine of ['pdflatex','xelatex','lualatex','bibtexu','makeindex','xdvipdfmx','biber']) {
  const source=join(root,'engine/build',engine,'emscripten');
  try {await access(join(source,`${engine}.wasm`));await access(join(source,`${engine}.js`));}catch{continue;}
  const target=join(root,'engine-artifacts',engine,'emscripten');await mkdir(target,{recursive:true});
  for(const file of [`${engine}.wasm`,`${engine}.js`,...(engine==='biber'?['biber-vfs.tar.gz']:[])])await copyFile(join(source,file),join(target,file));
  console.log(`Staged ${engine}`);
}
await copyFile(join(root,'vendor/texlive-source/libs/icu/icu-src/source/data/in/icudt78l.dat'),join(root,'engine-artifacts/icudt78l.dat'));
