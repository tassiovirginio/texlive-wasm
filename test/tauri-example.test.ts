import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handles: [] as { isReady: () => boolean; ready: boolean }[],
  fail: false,
}));
vi.mock('@typeward/texlive-wasm', () => ({
  PdfLatex: class {
    protected handle: { isReady: () => boolean } | null = null;
    constructor(protected options: unknown) {}
    async compile() {
      if (!this.handle?.isReady()) throw new Error('dead');
      return { exitCode: 0 };
    }
  },
  createEngine: async () => {
    if (mocks.fail) throw new Error('init failed');
    const h = {
      ready: true,
      isReady() {
        return this.ready;
      },
    };
    mocks.handles.push(h);
    return h;
  },
}));
vi.mock('@typeward/texlive-wasm/tauri', () => ({
  isTauri: () => true,
  withTauriFs: async (factory: (vfs: unknown[]) => unknown) => factory([]),
}));
import { PdfLatex } from '../examples/tauri/src/texlive';
beforeEach(() => {
  mocks.handles = [];
  mocks.fail = false;
  vi.stubGlobal('document', { baseURI: 'https://test/' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
});
it('reinitializes its Tauri backend after a worker is terminated', async () => {
  const engine = new PdfLatex();
  const opts = { mainTex: 'main.tex', files: [] };
  await engine.compile(opts);
  mocks.handles[0]!.ready = false;
  await expect(engine.compile(opts)).resolves.toMatchObject({ exitCode: 0 });
  expect(mocks.handles).toHaveLength(2);
  vi.unstubAllGlobals();
});
it('allows retrying a failed Tauri initialization', async () => {
  mocks.fail = true;
  const engine = new PdfLatex();
  const opts = { mainTex: 'main.tex', files: [] };
  await expect(engine.compile(opts)).rejects.toThrow('init failed');
  mocks.fail = false;
  await expect(engine.compile(opts)).resolves.toMatchObject({ exitCode: 0 });
  vi.unstubAllGlobals();
});
