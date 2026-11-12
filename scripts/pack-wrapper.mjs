/** Attach an installable npm tarball to releases, including forks without npm publishing. */
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const out=resolve(process.argv[2]??'release');
const checksums=JSON.parse(await readFile(join(out,'checksums.json'),'utf8'));
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(checksums.version.replace(/^v/,'')!==pkg.version)throw new Error('Wrapper and release versions differ');
const [packed]=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',out],{encoding:'utf8'}));
const bytes=await readFile(join(out,packed.filename));
checksums.assets[packed.filename]={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
await writeFile(join(out,'checksums.json'),JSON.stringify(checksums,null,2)+'\n');
console.log(`Packed installable wrapper: ${packed.filename}`);
