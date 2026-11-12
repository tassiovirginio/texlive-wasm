/**
 * Worker filesystem orchestration, driven against a fake Emscripten module
 * (test/worker-fs.ts) that reproduces the real WASMFS semantics.
 *
 * The headline case is the lazy TDS mount. It is worth a test with teeth:
 * the eager fallback still produces the right PDF, so when the mount broke it
 * broke silently — the only symptom was a quarter of a gigabyte of heap per
 * engine instance.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerImpl, type BackendHost, type BackendMeta } from '../src/core/worker';
import { createFakeModule, type FakeFs, type FakeModuleOptions } from './worker-fs';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

// The worker imports its glue by URL. This stand-in delegates to whatever the
// current test installed, so each test gets a module with its own behavior.
declare global {
  // eslint-disable-next-line no-var
  var __texliveFakeFactory: ((opts: unknown) => Promise<unknown>) | undefined;
}

let tmp: string;
let enginePath: string;
/** Every module the worker built, newest last: a run makes one per attempt. */
let instances: ReturnType<typeof createFakeModule>[] = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'texlive-wasm-test-'));
  writeFileSync(
    join(tmp, 'engine.js'),
    'export default async function factory(opts) { return globalThis.__texliveFakeFactory(opts); }\n',
  );
  // resolveEngineGlueUrl() derives the glue URL from the .wasm path.
  enginePath = pathToFileURL(join(tmp, 'engine.wasm')).href;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  instances = [];
  globalThis.__texliveFakeFactory = undefined;
  vi.restoreAllMocks();
});

function installEngine(options: FakeModuleOptions = {}): void {
  globalThis.__texliveFakeFactory = async () => {
    const module = createFakeModule(options);
    instances.push(module);
    return module;
  };
}

function lastStats() {
  return instances[instances.length - 1]!.__stats;
}

/** A TDS with just enough in it to satisfy the pdflatex format check. */
function tdsMap(extra: Record<string, string> = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ['web2c/pdftex/pdflatex.fmt', enc('FORMAT BYTES')],
    ['tex/latex/base/article.cls', enc('CLASS BYTES')],
  ]);
  for (const [path, content] of Object.entries(extra)) files.set(path, enc(content));
  return files;
}

function hostFor(tds: Map<string, Uint8Array>): { host: BackendHost; meta: BackendMeta[] } {
  const strip = (p: string) => p.replace(/^\/+/, '');
  return {
    host: {
      read: async (_i, path) => tds.get(strip(path)) ?? null,
      exists: async (_i, path) => tds.has(strip(path)),
      list: async () => [...tds.keys()],
      init: async () => {},
      dispose: async () => {},
    },
    meta: [{ id: 'test', hasList: true, hasInit: false, hasDispose: false }],
  };
}

/** A pdflatex that emits a log and a PDF and leaves the sources alone. */
const producesPdf = (args: string[], fs: FakeFs): number => {
  fs.writeFile('/project/main.log', 'This is pdfTeX\nOutput written on main.pdf');
  fs.writeFile('/project/main.pdf', '%PDF-1.5 FAKE');
  void args;
  return 0;
};

describe('worker: lazy TDS mount', () => {
  it('mounts the tree lazily and copies none of it into the wasm heap', async () => {
    installEngine({ callMain: producesPdf });
    const tds = tdsMap();
    const { host, meta } = hostFor(tds);
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    const result = await worker.run({
      args: ['main.tex'],
      files: [{ path: 'main.tex', content: 'doc' }],
    });

    expect(result.lazyTds).toBe(true);
    const stats = lastStats();
    expect(stats.mounted).toBe(true);
    // Every TDS file became a lazy node; none of their bytes went through the heap.
    expect(stats.touched).toBe(tds.size);
    expect(stats.eagerTdsBytes).toBe(0);
    // The mount must be the FIRST thing to touch /texmf-dist. Creating the
    // directory first makes wasmfs_create_directory return -EEXIST, which is
    // precisely how lazy mounting was disabled without anyone noticing.
    expect(stats.events[0]).toBe('mount ok');
    expect(stats.events).not.toContain('mount EEXIST');
  });

  it('serves file contents through the JS handler once mounted', async () => {
    let seen: string | undefined;
    installEngine({
      callMain: (_args, fs) => {
        seen = dec(fs.readFile('/texmf-dist/tex/latex/base/article.cls'));
        fs.writeFile('/project/main.log', 'ok');
        fs.writeFile('/project/main.pdf', 'PDF');
        return 0;
      },
    });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
    await worker.run({ args: ['main.tex'], files: [{ path: 'main.tex', content: 'doc' }] });

    expect(seen).toBe('CLASS BYTES');
  });

  it('falls back to eager materialization — loudly — on a pre-lazy artifact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installEngine({ callMain: producesPdf, withoutLazyBackend: true });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    const result = await worker.run({
      args: ['main.tex'],
      files: [{ path: 'main.tex', content: 'doc' }],
    });

    expect(result.lazyTds).toBe(false);
    expect(lastStats().eagerTdsBytes).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('materializing the TeX tree eagerly'),
    );
  });

  it('honors lazyTds: false', async () => {
    installEngine({ callMain: producesPdf });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init(
      { engineId: 'pdflatex', config: { enginePath, lazyTds: false }, backendMeta: meta },
      host,
    );

    const result = await worker.run({
      args: ['main.tex'],
      files: [{ path: 'main.tex', content: 'doc' }],
    });

    expect(result.lazyTds).toBe(false);
    expect(lastStats().eagerTdsBytes).toBeGreaterThan(0);
  });
});

describe('worker: run', () => {
  it('returns what the engine produced, not the inputs it was handed', async () => {
    installEngine({ callMain: producesPdf });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    const result = await worker.run({
      args: ['main.tex'],
      files: [
        { path: 'main.tex', content: 'doc' },
        // A big unchanged asset must not ride back across the boundary.
        { path: 'figures/plot.png', content: new Uint8Array(4096) },
      ],
    });

    expect([...result.outputs.keys()].sort()).toEqual(['main.log', 'main.pdf']);
    expect(dec(result.outputs.get('main.pdf'))).toBe('%PDF-1.5 FAKE');
  });

  it('returns an input the engine rewrote', async () => {
    installEngine({
      callMain: (_args, fs) => {
        fs.writeFile('/project/main.tex', 'REWRITTEN');
        fs.writeFile('/project/main.log', 'ok');
        fs.writeFile('/project/main.pdf', 'PDF');
        return 0;
      },
    });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    const result = await worker.run({
      args: ['main.tex'],
      files: [{ path: 'main.tex', content: 'doc' }],
    });

    expect(dec(result.outputs.get('main.tex'))).toBe('REWRITTEN');
  });

  it('refuses a file input that escapes /project', async () => {
    installEngine({ callMain: producesPdf });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    await expect(
      worker.run({
        args: ['main.tex'],
        files: [{ path: '../../texmf-dist/web2c/pdftex/pdflatex.fmt', content: 'EVIL' }],
      }),
    ).rejects.toThrow(/escaping path/);
  });

  it('refuses a cwd outside /project', async () => {
    installEngine({ callMain: producesPdf });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    // The engine writes its outputs relative to the cwd, and everything under
    // it comes back to the caller.
    await expect(worker.run({ args: ['main.tex'], cwd: '/texmf-dist', files: [] })).rejects.toThrow(
      /cwd outside \/project/,
    );
    await expect(
      worker.run({ args: ['main.tex'], cwd: '/project/../texmf-dist', files: [] }),
    ).rejects.toThrow(/cwd outside \/project/);
  });

  it('fails fast, and by name, when the engine has no format', async () => {
    installEngine({ callMain: producesPdf });
    const tds = new Map([['tex/latex/base/article.cls', enc('CLASS')]]);
    const { host, meta } = hostFor(tds);
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    // Without this the engine reaches for mktexfmt, which needs fork(2).
    await expect(
      worker.run({ args: ['main.tex'], files: [{ path: 'main.tex', content: 'doc' }] }),
    ).rejects.toThrow(/no LaTeX format for pdflatex/);
  });

  it('lets a caller select their own format (-ini builds one)', async () => {
    installEngine({ callMain: producesPdf });
    const tds = new Map([['tex/latex/base/article.cls', enc('CLASS')]]);
    const { host, meta } = hostFor(tds);
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);

    const result = await worker.run({ args: ['-ini', 'main.tex'], files: [] });
    expect(result.exitCode).toBe(0);
  });
});

describe('worker: lazy fetch for helper tools', () => {
  it("resolves a missing .bst out of bibtexu's own .blg and retries", async () => {
    let call = 0;
    installEngine({
      callMain: (_args, fs) => {
        call++;
        if (call === 1) {
          // bibtexu writes a .blg, not a .log — reading the wrong file is why
          // the on-miss retry never fired for the helper tools.
          fs.writeFile('/project/main.blg', "I couldn't open style file plainnat.bst\n");
          return 1;
        }
        fs.writeFile('/project/main.blg', 'ok\n');
        fs.writeFile('/project/main.bbl', 'BBL');
        return 0;
      },
    });
    const tds = tdsMap({ 'bibtex/bst/plainnat/plainnat.bst': 'BST BYTES' });
    // The style is in the backend but not in the drained tree: drop it from
    // list() so only the on-miss path can find it.
    const { host, meta } = hostFor(tds);
    const listed = [...tds.keys()].filter((p) => p !== 'bibtex/bst/plainnat/plainnat.bst');
    host.list = async () => listed;

    const worker = new WorkerImpl();
    await worker.init({ engineId: 'bibtexu', config: { enginePath }, backendMeta: meta }, host);
    const result = await worker.run({
      args: ['main.aux'],
      files: [{ path: 'main.aux', content: '\\bibstyle{plainnat}' }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.lazyFetchRetries).toBe(1);
    expect(dec(result.outputs.get('main.bbl'))).toBe('BBL');
  });
});

it('keeps the first listed backend authoritative for duplicate paths', async () => {
  let content: string | undefined;
  installEngine({
    callMain: (_args, fs) => {
      content = dec(fs.readFile('/texmf-dist/tex/latex/base/article.cls'));
      return producesPdf([], fs);
    },
  });
  const first = tdsMap({ 'tex/latex/base/article.cls': 'FIRST' });
  const second = tdsMap({ 'tex/latex/base/article.cls': 'SECOND' });
  const { host, meta } = hostFor(first);
  host.read = async (i, p) => (i === 0 ? first : second).get(p) ?? null;
  const worker = new WorkerImpl();
  await worker.init(
    { engineId: 'pdflatex', config: { enginePath }, backendMeta: [meta[0]!, meta[0]!] },
    host,
  );
  await worker.run({ args: ['main.tex'] });
  expect(content).toBe('FIRST');
});

it('resolves versioned engine URLs and loads an explicit format ahead of bundled formats', async () => {
  let format: string | undefined;
  installEngine({
    callMain: (_args, fs) => {
      format = dec(fs.readFile('/texmf-dist/web2c/pdftex/pdflatex.fmt'));
      return producesPdf([], fs);
    },
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('CUSTOM FORMAT'));
  const { host, meta } = hostFor(tdsMap());
  const worker = new WorkerImpl();
  await worker.init(
    {
      engineId: 'pdflatex',
      config: { enginePath: `${enginePath}?v=1`, fmtPath: 'https://test/format' },
      backendMeta: meta,
    },
    host,
  );
  await worker.run({ args: ['main.tex'] });
  expect(format).toBe('CUSTOM FORMAT');
  expect(fetchMock).toHaveBeenCalledWith('https://test/format');
});

it('provides UTF-8 stdin to each fresh Emscripten instance', async () => {
  let received = '';
  globalThis.__texliveFakeFactory = async (options: unknown) => {
    const { stdin } = options as { stdin: () => number | null };
    const bytes: number[] = [];
    for (let b = stdin(); b !== null; b = stdin()) bytes.push(b);
    received = new TextDecoder().decode(new Uint8Array(bytes));
    return createFakeModule({ callMain: producesPdf });
  };
  const { host, meta } = hostFor(tdsMap());
  const worker = new WorkerImpl();
  await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
  await worker.run({ args: ['main.tex'], stdin: 'olá\n' });
  expect(received).toBe('olá\n');
  await worker.run({ args: ['main.tex'], stdin: new Uint8Array([65]) });
  expect(received).toBe('A');
});
it('honors explicit format selection and reads logs from a confined custom cwd', async () => {
  installEngine({
    callMain: (args, fs) => {
      expect(args.some((arg) => arg.startsWith('-fmt='))).toBe(false);
      fs.writeFile('/project/sub/main.log', 'custom log');
      return 0;
    },
  });
  const { host, meta } = hostFor(tdsMap());
  const worker = new WorkerImpl();
  await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
  const result = await worker.run({
    args: ['-ini', 'main.tex'],
    cwd: '/project/sub',
    files: [{ path: 'sub/main.tex', content: 'source' }],
  });
  expect(result.log).toBe('custom log');
});

describe('worker environment and persistent caches', () => {
  it('sets real process variables on every fresh instance before main', async () => {
    const values: string[] = [];
    globalThis.__texliveFakeFactory = async () => {
      const module = createFakeModule({ callMain: producesPdf });
      instances.push(module);
      return Object.assign(module, {
        _texlive_setenv: (key: number, value: number) => {
          const cstr = (p: number) =>
            new TextDecoder().decode(module.HEAPU8.subarray(p, module.HEAPU8.indexOf(0, p)));
          values.push(cstr(key) + '=' + cstr(value));
          return 0;
        },
      });
    };
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
    await worker.run({ args: ['main.tex'], processEnv: { SOURCE_DATE_EPOCH: '946684800' } });
    await worker.run({ args: ['main.tex'], processEnv: { FORCE_SOURCE_DATE: '1' } });
    expect(values).toEqual(['SOURCE_DATE_EPOCH=946684800', 'FORCE_SOURCE_DATE=1']);
    await expect(
      worker.run({ args: ['main.tex'], processEnv: { 'bad=key': 'value' } }),
    ).rejects.toThrow('Invalid process');
    await expect(
      worker.run({ args: ['main.tex'], processEnv: { GOOD: 'bad\0value' } }),
    ).rejects.toThrow('Invalid process');
  });
  it('fails explicitly when an older artifact cannot apply processEnv', async () => {
    installEngine({ callMain: producesPdf });
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
    await expect(
      worker.run({ args: ['main.tex'], processEnv: { SOURCE_DATE_EPOCH: '1' } }),
    ).rejects.toThrow('requires an engine');
  });
  it('persists fontconfig caches between XeTeX instances and clears them on dispose', async () => {
    let count = 0;
    installEngine({
      callMain: (_args, fs) => {
        if (count++) expect(dec(fs.readFile('/tmp/fontcache/fonts.cache'))).toBe('CACHE');
        fs.writeFile('/tmp/fontcache/fonts.cache', 'CACHE');
        return 0;
      },
    });
    const { host, meta } = hostFor(new Map([['web2c/xetex/xelatex.fmt', enc('FMT')]]));
    const worker = new WorkerImpl();
    await worker.init({ engineId: 'xelatex', config: { enginePath }, backendMeta: meta }, host);
    await worker.run({ args: ['main.tex'] });
    await worker.run({ args: ['main.tex'] });
    expect(count).toBe(2);
    await worker.dispose();
  });
  it('rejects positive ICU errors while accepting negative warning statuses', async () => {
    let status = 3;
    globalThis.__texliveFakeFactory = async () => {
      const module = createFakeModule({ callMain: producesPdf });
      instances.push(module);
      return Object.assign(module, {
        _udata_setCommonData_78: (_data: number, err: number) => {
          module.HEAPU32[err >> 2] = status;
        },
      });
    };
    const { host, meta } = hostFor(tdsMap());
    const worker = new WorkerImpl();
    await worker.init(
      { engineId: 'pdflatex', config: { enginePath }, backendMeta: meta, icuData: enc('ICU') },
      host,
    );
    await expect(worker.run({ args: ['main.tex'] })).rejects.toThrow('ICU data initialization');
    status = -1;
    expect((await worker.run({ args: ['main.tex'] })).exitCode).toBe(0);
  });
});

it('adds integrity-pinned resource packs while retaining base TDS precedence', async () => {
  const { buildTar } = await import('./helpers');
  const { gzipSync } = await import('node:zlib');
  const { createHash } = await import('node:crypto');
  const bytes = gzipSync(
    buildTar([
      { path: 'texmf/tex/latex/base/article.cls', content: 'PACK CLASS' },
      { path: 'texmf/tex/generic/babel-portuges/brazil.ldf', content: 'PORTUGUESE' },
    ]),
  );
  const path = join(tmp, 'language.tar.gz');
  writeFileSync(path, bytes);
  installEngine({
    callMain: (_args, fs) => {
      expect(dec(fs.readFile('/texmf-dist/tex/latex/base/article.cls'))).toBe('CLASS BYTES');
      expect(dec(fs.readFile('/texmf-dist/tex/generic/babel-portuges/brazil.ldf'))).toBe(
        'PORTUGUESE',
      );
      return 0;
    },
  });
  const { host, meta } = hostFor(tdsMap());
  const worker = new WorkerImpl();
  // The explicit host backend is after additive packs; a configured base bundle
  // is the authoritative first layer. Put its bytes in a tiny base bundle.
  const base = gzipSync(
    buildTar([
      { path: 'texmf/tex/latex/base/article.cls', content: 'CLASS BYTES' },
      { path: 'texmf/web2c/pdftex/pdflatex.fmt', content: 'FMT' },
    ]),
  );
  const basePath = join(tmp, 'base.tar.gz');
  writeFileSync(basePath, base);
  await worker.init(
    {
      engineId: 'pdflatex',
      config: {
        enginePath,
        bundleUrl: pathToFileURL(basePath).href,
        resourcePacks: [
          {
            url: pathToFileURL(path).href,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      backendMeta: meta,
    },
    host,
  );
  expect((await worker.run({ args: ['main.tex'] })).exitCode).toBe(0);
  const bad = new WorkerImpl();
  await expect(
    bad.init({
      engineId: 'pdflatex',
      config: {
        enginePath,
        resourcePacks: [{ url: pathToFileURL(path).href, sha256: '0'.repeat(64) }],
      },
    }),
  ).rejects.toThrow(/SHA-256|integrity|hash/i);
});

it('invalidates engine font caches when a project font changes at the same path', async () => {
  const seen: boolean[] = [];
  installEngine({
    callMain: (_args, fs) => {
      try {
        fs.stat('/tmp/texmf-var/font.cache');
        seen.push(true);
      } catch {
        seen.push(false);
      }
      fs.writeFile('/tmp/texmf-var/font.cache', 'cached metrics');
      return 0;
    },
  });
  const { host, meta } = hostFor(tdsMap());
  const worker = new WorkerImpl();
  await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
  for (const content of ['FONT-A', 'FONT-A', 'FONT-B'])
    await worker.run({ args: ['main.tex'], files: [{ path: 'font.otf', content }] });
  expect(seen).toEqual([false, true, false]);
  await worker.dispose();
});
it('resolves a missing babel language definition through the fallback backend', async () => {
  installEngine({
    callMain: (_args, fs) => {
      try {
        fs.stat('/texmf-dist/tex/generic/babel-portuges/brazil.ldf');
        return 0;
      } catch {
        fs.writeFile(
          '/project/main.log',
          '! Package babel Error: Unknown option brazil\n(babel) or the language definition file brazil.ldf\n(babel) was not found.',
        );
        return 1;
      }
    },
  });
  const { host, meta } = hostFor(tdsMap());
  const originalRead = host.read;
  host.read = async (index, path) =>
    path === 'tex/generic/babel-portuges/brazil.ldf'
      ? enc('PORTUGUESE')
      : originalRead(index, path);
  const worker = new WorkerImpl();
  await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
  const r = await worker.run({ args: ['main.tex'] });
  expect(r.exitCode).toBe(0);
  expect(r.lazyFetchRetries).toBe(1);
  await worker.dispose();
});

it('loads a complete verified package from a backend basename resolver', async () => {
  installEngine({
    callMain: (_args, fs) => {
      try {
        fs.stat('/texmf-dist/tex/latex/pkg/missing.sty');
        fs.stat('/texmf-dist/tex/latex/pkg/dependency.sty');
        return 0;
      } catch {
        fs.writeFile('/project/main.log', "! LaTeX Error: File `missing.sty' not found.");
        return 1;
      }
    },
  });
  const { host, meta } = hostFor(tdsMap());
  meta[0]!.hasResolve = true;
  host.resolve = async (_index, name) =>
    name === 'missing.sty'
      ? [
          { path: 'tex/latex/pkg/missing.sty', content: enc('PKG') },
          { path: 'tex/latex/pkg/dependency.sty', content: enc('DEP') },
          { path: '../escape', content: enc('BAD') },
        ]
      : [];
  const worker = new WorkerImpl();
  await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
  const r = await worker.run({ args: ['main.tex'] });
  expect(r.exitCode).toBe(0);
  expect(r.lazyFetchRetries).toBe(1);
  await worker.dispose();
});
it('reconstructs exactly the new project manifest from cached input blobs', async () => {
  let runs = 0;
  installEngine({
    callMain: (_args, fs) => {
      if (runs++ === 0) {
        fs.stat('/project/deleted.tex');
        return 0;
      }
      try {
        fs.stat('/project/deleted.tex');
        throw Error('deleted file survived');
      } catch (e) {
        if ((e as Error).message === 'deleted file survived') throw e;
      }
      return 0;
    },
  });
  const { sha256Hex } = await import('../src/core/manifest');
  const bytes = enc('SOURCE');
  const hash = await sha256Hex(bytes);
  const { host, meta } = hostFor(tdsMap());
  const worker = new WorkerImpl();
  await worker.init({ engineId: 'pdflatex', config: { enginePath }, backendMeta: meta }, host);
  await worker.run({
    args: ['main.tex'],
    fileRefs: [
      { path: 'main.tex', sha256: hash },
      { path: 'deleted.tex', sha256: hash },
    ],
    fileBlobs: [{ sha256: hash, content: bytes }],
  });
  const r = await worker.run({
    args: ['main.tex'],
    fileRefs: [{ path: 'renamed.tex', sha256: hash }],
  });
  expect(r.inputTransport).toEqual({ sentBytes: 0, reusedBytes: bytes.length });
  await worker.dispose();
});
