import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpfsFs } from '../src/vfs/opfsfs';
class Directory {
  dirs = new Map<string, Directory>();
  files = new Map<string, Uint8Array>();
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory> {
    if (!this.dirs.has(name)) {
      if (!options?.create) throw new Error('NotFound');
      this.dirs.set(name, new Directory());
    }
    return this.dirs.get(name)!;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && !options?.create) throw new Error('NotFound');
    return {
      getFile: async () => ({ arrayBuffer: async () => this.files.get(name)!.slice().buffer }),
      createWritable: async () => ({
        write: async (b: Uint8Array) => {
          this.files.set(name, b.slice());
        },
        close: async () => {},
      }),
    };
  }
}
afterEach(() => vi.unstubAllGlobals());
describe('OPFS cache', () => {
  it('persists across backend instances, separates versions and prefers full tier', async () => {
    const root = new Directory();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const a = await createOpfsFs({ version: 'v1' });
    await a.write('tex/a.sty', new Uint8Array([1]));
    const b = await createOpfsFs({ version: 'v1' });
    expect(await b.read('tex/a.sty')).toEqual(new Uint8Array([1]));
    expect(await (await createOpfsFs({ version: 'v2' })).read('tex/a.sty')).toBeNull();
    const full = root.dirs.get('texlive-wasm')!.dirs.get('v1')!.dirs.get('full')!;
    const tex = await full.getDirectoryHandle('tex', { create: true });
    tex.files.set('a.sty', new Uint8Array([2]));
    expect(await b.read('tex/a.sty')).toEqual(new Uint8Array([2]));
    expect(await b.read('../escape')).toBeNull();
    await b.write('../escape', new Uint8Array([3]));
    expect(await b.read('missing/file')).toBeNull();
  });
  it('treats full or unavailable storage as a best-effort cache write', async () => {
    const root = new Directory();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const fs = await createOpfsFs({ version: '../../version' });
    const cdn = [...root.dirs.get('texlive-wasm')!.dirs.values()][0]!.dirs.get('cdn')!;
    vi.spyOn(cdn, 'getFileHandle').mockRejectedValue(new Error('quota'));
    await expect(fs.write('a', new Uint8Array([1]))).resolves.toBeUndefined();
    expect(await fs.read('a')).toBeNull();
  });
});
