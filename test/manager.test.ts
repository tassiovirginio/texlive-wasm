import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle, EngineId, RunResult } from '../src/core/types';

const created: EngineId[] = [];
const disposed: EngineId[] = [];
let failRun = false;
let failFor: EngineId | null = null;
/** Set to hold a run open: the manager must not evict an engine mid-compile. */
let runGate: { promise: Promise<void>; release: () => void } | null = null;

vi.mock('../src/core/engine', () => ({
  createEngine: async (id: EngineId): Promise<EngineHandle> => {
    if (failFor === id) throw new Error(`boom ${id}`);
    created.push(id);
    // Mirrors the real handle: disposing terminates the worker, and a
    // terminated worker reports itself not ready ever after (engine.ts).
    let ready = true;
    return {
      id,
      config: {},
      run: async (): Promise<RunResult> => {
        if (failRun) {
          ready = false;
          throw new Error('terminated');
        }
        if (runGate) await runGate.promise;
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputs: new Map(),
          log: '',
          durationMs: 1,
        };
      },
      dispose: async () => {
        ready = false;
        disposed.push(id);
      },
      isReady: () => ready,
    };
  },
}));

import { createEngineManager } from '../src/core/manager';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  created.length = 0;
  disposed.length = 0;
  failFor = null;
  failRun = false;
  runGate = null;
});

const config = () => ({});

describe('createEngineManager', () => {
  it('memoizes handles per engine', async () => {
    const mgr = createEngineManager({ config });
    const a = await mgr.engine('pdflatex');
    const b = await mgr.engine('pdflatex');
    expect(a).toBe(b);
    expect(created).toEqual(['pdflatex']);
  });

  it('evicts the least-recently-used idle engine at the cap', async () => {
    const evicted: EngineId[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 2,
      onEvict: (id) => evicted.push(id),
    });
    await mgr.engine('pdflatex');
    await mgr.engine('bibtexu');
    await mgr.engine('pdflatex'); // bump pdflatex → bibtexu is now LRU
    await mgr.engine('makeindex'); // over cap → bibtexu evicted
    expect(evicted).toEqual(['bibtexu']);
    await vi.waitFor(() => expect(disposed).toContain('bibtexu'));
    expect(mgr.live().sort()).toEqual(['makeindex', 'pdflatex']);
  });

  it('never evicts engines pinned by withEngines', async () => {
    const evicted: EngineId[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 1,
      onEvict: (id) => evicted.push(id),
    });
    await mgr.withEngines(['pdflatex', 'bibtexu'], async (handles) => {
      expect(handles.size).toBe(2);
      // Cap is 1 but both are pinned — nothing may be evicted mid-pipeline.
      await mgr.engine('makeindex');
      expect(evicted).not.toContain('pdflatex');
      expect(evicted).not.toContain('bibtexu');
    });
    // After unpinning, new demand can evict them again.
    await mgr.engine('xdvipdfmx');
    expect(evicted.length).toBeGreaterThan(0);
  });

  it('a failed init does not poison the slot', async () => {
    const mgr = createEngineManager({ config });
    failFor = 'lualatex';
    await expect(mgr.engine('lualatex')).rejects.toThrow('boom');
    failFor = null;
    failRun = false;
    await expect(mgr.engine('lualatex')).resolves.toBeDefined();
  });

  it('dispose() without id tears everything down', async () => {
    const mgr = createEngineManager({ config });
    await mgr.engine('pdflatex');
    await mgr.engine('bibtexu');
    await mgr.dispose();
    expect(disposed.sort()).toEqual(['bibtexu', 'pdflatex']);
    expect(mgr.live()).toEqual([]);
  });

  it('never evicts an engine that is mid-run', async () => {
    const evicted: EngineId[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 1,
      onEvict: (id) => evicted.push(id),
    });
    runGate = gate();

    const pdflatex = await mgr.engine('pdflatex');
    const inFlight = pdflatex.run({ args: ['main.tex'] });
    // Demand another engine while the first is still inside callMain. Evicting
    // it here would terminate a worker mid-compile — the run's reply could
    // never arrive.
    await mgr.engine('bibtexu');
    expect(evicted).not.toContain('pdflatex');

    runGate.release();
    await expect(inFlight).resolves.toMatchObject({ exitCode: 0 });

    // Once the run is done the engine is idle again and may be evicted.
    await mgr.engine('makeindex');
    expect(evicted).toContain('pdflatex');
  });

  it('waits for the evicted engine to be gone before loading the next', async () => {
    const order: string[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 1,
      onEvict: (id) => order.push(`evict ${id}`),
      onLoad: (id) => order.push(`load ${id}`),
    });
    await mgr.engine('pdflatex');
    await mgr.engine('bibtexu');

    // The old worker's memory must be released before the new one allocates
    // its own tree — that peak is the whole point of the cap.
    expect(order).toEqual(['load pdflatex', 'evict pdflatex', 'load bibtexu']);
    expect(disposed).toEqual(['pdflatex']);
    expect(created).toEqual(['pdflatex', 'bibtexu']);
  });

  it('a handle evicted between two runs reloads instead of dying', async () => {
    const mgr = createEngineManager({ config, maxLiveEngines: 1 });
    const pdflatex = await mgr.engine('pdflatex');
    await pdflatex.run({ args: ['main.tex'] });

    // Another compile takes the only slot; pdflatex is idle, so it is evicted.
    await mgr.engine('bibtexu');
    await vi.waitFor(() => expect(disposed).toContain('pdflatex'));

    // The caller still holds its handle. Running it must reload the engine,
    // not hand back the worker that was terminated underneath it.
    await expect(pdflatex.run({ args: ['main.tex'] })).resolves.toMatchObject({ exitCode: 0 });
    expect(created).toEqual(['pdflatex', 'bibtexu', 'pdflatex']);
  });

  it('reports readiness for the engine the next run would use, not the evicted worker', async () => {
    const mgr = createEngineManager({ config, maxLiveEngines: 1 });
    const pdflatex = await mgr.engine('pdflatex');
    expect(pdflatex.isReady()).toBe(true);

    // Evicted between runs: the worker it was minted around is terminated.
    await mgr.engine('bibtexu');
    await vi.waitFor(() => expect(disposed).toContain('pdflatex'));
    expect(pdflatex.isReady()).toBe(false);

    // run() reloads it, so isReady() must agree that it is live again rather
    // than keep answering for the worker that is gone.
    await pdflatex.run({ args: ['main.tex'] });
    expect(pdflatex.isReady()).toBe(true);
  });

  it('does not evict the engine a leased handle is about to run on', async () => {
    const evicted: EngineId[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 1,
      onEvict: (id) => evicted.push(id),
    });
    runGate = gate();

    const pdflatex = await mgr.engine('pdflatex');
    // run() pins synchronously, before it awaits the worker — so a compile
    // that starts in the same tick cannot take the slot out from under it.
    const inFlight = pdflatex.run({ args: ['main.tex'] });
    const other = mgr.engine('bibtexu');

    expect(evicted).not.toContain('pdflatex');
    runGate.release();
    await expect(inFlight).resolves.toMatchObject({ exitCode: 0 });
    await other;
  });

  it('disposing a leased handle retires the slot rather than leaving a dead one', async () => {
    const mgr = createEngineManager({ config });
    const first = await mgr.engine('pdflatex');
    await first.dispose();
    expect(disposed).toEqual(['pdflatex']);
    expect(mgr.live()).toEqual([]);

    // The next request must build a fresh worker, not hand back the dead one.
    const second = await mgr.engine('pdflatex');
    expect(second).not.toBe(first);
    expect(created).toEqual(['pdflatex', 'pdflatex']);
  });
});

it('recreates a worker that died outside the manager and repairs old leases', async () => {
  const mgr = createEngineManager({ config });
  const lease = await mgr.engine('pdflatex');
  // Simulate a worker termination observed through isReady().
  // The mock can kill its raw worker during a run, like timeout/abort.
  failRun = true;
  await expect(lease.run({ args: [] })).rejects.toThrow('terminated');
  failRun = false;
  await expect(lease.run({ args: [] })).resolves.toMatchObject({ exitCode: 0 });
  expect(created).toEqual(['pdflatex', 'pdflatex']);
});

it('returns to the memory cap after a multi-engine scope releases its pins', async () => {
  const mgr = createEngineManager({ config, maxLiveEngines: 1 });
  await mgr.withEngines(['pdflatex', 'bibtexu', 'makeindex', 'xdvipdfmx'], async (handles) => {
    expect(handles.size).toBe(4);
    expect(mgr.live()).toHaveLength(4);
  });
  expect(mgr.live()).toHaveLength(1);
  expect(disposed).toHaveLength(3);
});
