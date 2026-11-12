import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineHandle, RunOptions } from '../src/core/types';
const state = vi.hoisted(() => ({
  calls: [] as { id: string; options: RunOptions }[],
  fail: false,
  loaded: [] as string[],
}));
vi.mock('../src/core/engine', () => ({
  createEngine: vi.fn(async (id: string) => {
    state.loaded.push(id);
    let ready = true;
    return {
      id,
      config: {},
      isReady: () => ready,
      dispose: async () => {
        ready = false;
      },
      run: async (options: RunOptions) => {
        state.calls.push({ id, options });
        if (state.fail) throw Error('failed');
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          log: '',
          durationMs: 1,
          outputs: new Map(
            Object.entries(
              id === 'xdvipdfmx'
                ? { 'main.pdf': 'P' }
                : id === 'makeindex'
                  ? { 'main.ind': 'INDEX' }
                  : id === 'biber' || id === 'bibtexu'
                    ? { 'main.bbl': 'BBL' }
                    : { 'main.aux': 'A', 'main.pdf': 'P', 'main.xdv': 'X' },
            ).map(([p, s]) => [p, new TextEncoder().encode(s)]),
          ),
        };
      },
    } as EngineHandle;
  }),
}));
import { createCompileSession } from '../src/latexmk/session';
beforeEach(() => {
  state.calls = [];
  state.fail = false;
  state.loaded = [];
});
const config = () => ({});
const options = {
  engine: 'pdflatex' as const,
  mainTex: 'main.tex',
  files: [{ path: 'main.tex', content: 'first' }],
};
describe('incremental compile session', () => {
  it('reuses workers and auxiliary files on edits but invalidates changed assets and removed files', async () => {
    const s = createCompileSession({ config, resourceVersion: 'v1' });
    await s.compile(options);
    state.calls = [];
    await s.compile({ ...options, files: [{ path: 'main.tex', content: 'edited' }] });
    expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(true);
    expect(state.loaded).toEqual(['pdflatex']);
    state.calls = [];
    await s.compile({
      ...options,
      files: [...options.files, { path: 'image.png', content: new Uint8Array([1]) }],
    });
    expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
    state.calls = [];
    await s.compile(options);
    expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
    await s.dispose();
    await expect(s.compile(options)).rejects.toThrow('disposed');
  });
  it('clears seeds after failures and explicit invalidation', async () => {
    const s = createCompileSession({ config, resourceVersion: 'v1' });
    await s.compile(options);
    s.clear();
    state.calls = [];
    await s.compile(options);
    expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
    state.fail = true;
    await expect(s.compile(options)).rejects.toThrow('failed');
    state.fail = false;
    state.calls = [];
    await s.compile(options);
    expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
    await s.dispose();
  });
  it('serializes calls, snapshots sources, and reuses the XeTeX helper', async () => {
    const s = createCompileSession({ config, resourceVersion: 'v1', maxLiveEngines: 3 });
    const files = [{ path: 'main.tex', content: 'original' }];
    const a = s.compile({ ...options, engine: 'xelatex', files });
    files[0]!.content = 'changed';
    const b = s.compile({ ...options, engine: 'xelatex' });
    await Promise.all([a, b]);
    expect(state.calls[0]!.options.files!.find((f) => f.path === 'main.tex')!.content).toBe(
      'original',
    );
    expect(state.loaded).toEqual(['xelatex', 'xdvipdfmx']);
    await s.dispose();
  });
  it('preloads bibliography, indexing and glossary helpers and does not cache tool-modified projects', async () => {
    for (const source of [
      '\\bibliography{refs}',
      '\\usepackage{biblatex}',
      '\\makeindex',
      '\\makeglossaries',
    ]) {
      const s = createCompileSession({ config, resourceVersion: 'v1' });
      await s.compile({ ...options, files: [{ path: 'main.tex', content: source }] });
      await s.dispose();
    }
    expect(state.loaded).toEqual(expect.arrayContaining(['bibtexu', 'biber', 'makeindex']));
    const s = createCompileSession({ config, resourceVersion: 'v1' });
    await s.compile({ ...options, tools: async () => [] });
    state.calls = [];
    await s.compile(options);
    expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
    await s.dispose();
  });
});

it('invalidates changed preambles and same-path binary assets', async () => {
  const s = createCompileSession({ config, resourceVersion: 'v1' });
  const make = (cls: string, b: number) => ({
    ...options,
    files: [
      { path: 'main.tex', content: `\\documentclass{${cls}}\\begin{document}Text\\end{document}` },
      { path: 'font.otf', content: new Uint8Array([b]) },
    ],
  });
  await s.compile(make('article', 1));
  state.calls = [];
  await s.compile(make('article', 2));
  expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
  state.calls = [];
  await s.compile(make('report', 2));
  expect(state.calls[0]!.options.files!.some((f) => f.path === 'main.aux')).toBe(false);
  await s.dispose();
});
it('rejects invalid timeouts and pre-cancelled jobs before loading a worker', async () => {
  const s = createCompileSession({ config, resourceVersion: 'v1' });
  await expect(s.compile({ ...options, timeoutMs: -1 })).rejects.toThrow('Invalid timeoutMs');
  const c = new AbortController();
  c.abort();
  await expect(s.compile({ ...options, signal: c.signal })).rejects.toThrow('aborted');
  expect(state.loaded).toHaveLength(0);
  await s.dispose();
});
