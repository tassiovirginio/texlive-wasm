import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initSync} from '../rust/pkg/texlive_wasm.js';
import * as rust from '../rust/pkg/texlive_wasm.js';
import {willRunBibtex,willRunBiber,willRunMakeindex} from '../dist/index.js';
initSync({module:readFileSync(new URL('../rust/pkg/texlive_wasm_bg.wasm',import.meta.url))});
for(const fixture of JSON.parse(readFileSync(new URL('./fixtures/source-detection.json',import.meta.url),'utf8'))) {
  const files=[{path:fixture.path,content:fixture.content}];
  const json=JSON.stringify(files);
  assert.equal(rust.willRunBibtex(json),willRunBibtex(files));
  assert.equal(rust.willRunBiber(json),willRunBiber(files));
  assert.equal(rust.detectMakeindex(json),willRunMakeindex(files));
}
console.log('Rust/WASM and TypeScript source-detection parity passed');
