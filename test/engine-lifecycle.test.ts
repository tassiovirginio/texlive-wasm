import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/core/engine';
import type { WorkerApi } from '../src/core/worker';

const mocks = vi.hoisted(() => ({ api: { init: vi.fn(), run: vi.fn(), dispose: vi.fn() } }));
vi.mock('comlink', () => ({ wrap: () => mocks.api, proxy: (x: unknown) => x }));
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  terminate = vi.fn();
  constructor(..._args: unknown[]) {
    super();
    FakeWorker.instances.push(this);
  }
}
const result = { exitCode: 0, stdout: '', stderr: '', log: '', durationMs: 1, outputs: new Map() };
const create = (extra = {}) => createEngine('pdflatex', { useWorker: true, vfs: [], ...extra });
beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  mocks.api.init.mockReset().mockResolvedValue(undefined);
  mocks.api.run.mockReset().mockResolvedValue(result);
  mocks.api.dispose.mockReset().mockResolvedValue(undefined);
  FakeWorker.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('engine worker lifecycle', () => {
  it('rejects a failed initialization and terminates the worker', async () => {
    mocks.api.init.mockRejectedValue(new Error('load failed'));
    await expect(create()).rejects.toThrow('load failed');
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
  });
  it.each(['error', 'messageerror'])(
    'rejects an in-flight RPC when the worker emits %s',
    async (event) => {
      const handle = await create();
      mocks.api.run.mockImplementation(() => new Promise(() => {}));
      const run = handle.run({ args: [] });
      const rejected = expect(run).rejects.toThrow('worker');
      await Promise.resolve();
      FakeWorker.instances[0]!.dispatchEvent(new Event(event));
      await rejected;
      expect(handle.isReady()).toBe(false);
      await expect(handle.run({ args: [] })).rejects.toThrow('disposed');
    },
  );
  it('serializes executions', async () => {
    let release!: (r: typeof result) => void;
    mocks.api.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const handle = await create();
    const first = handle.run({ args: ['first'] });
    const second = handle.run({ args: ['second'] });
    await Promise.resolve();
    expect(mocks.api.run).toHaveBeenCalledTimes(1);
    release(result);
    await Promise.all([first, second]);
    expect(mocks.api.run).toHaveBeenCalledTimes(2);
    await handle.dispose();
  });
  it('terminates on deadline and settles queued calls', async () => {
    vi.useFakeTimers();
    const handle = await create();
    mocks.api.run.mockImplementation(() => new Promise(() => {}));
    const first = expect(handle.run({ args: [], timeoutMs: 10 })).rejects.toThrow('exceeded');
    const second = expect(handle.run({ args: [] })).rejects.toThrow('exceeded');
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second]);
    expect(handle.isReady()).toBe(false);
  });
  it('aborts a run and does not clone AbortSignals', async () => {
    const handle = await create();
    mocks.api.run.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const rejected = expect(handle.run({ args: [], signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(mocks.api.run.mock.calls[0]![0]).not.toHaveProperty('signal');
    await handle.dispose();
  });
  it('bounds initialization and terminates a worker stuck in init', async () => {
    vi.useFakeTimers();
    mocks.api.init.mockImplementation(() => new Promise(() => {}));
    const rejected = expect(create({ initTimeoutMs: 10 })).rejects.toThrow('initialization');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
  });
  it('does not create a worker when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(create({ initSignal: controller.signal })).rejects.toThrow('initialization');
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('bounds disposal and settles an active call', async () => {
    vi.useFakeTimers();
    const handle = await create();
    mocks.api.run.mockImplementation(() => new Promise(() => {}));
    mocks.api.dispose.mockImplementation(() => new Promise(() => {}));
    const rejected = expect(handle.run({ args: [] })).rejects.toThrow('disposed');
    await Promise.resolve();
    const disposal = handle.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([rejected, disposal]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('provides cloneable init configuration', async () => {
    const handle = await create();
    const options = mocks.api.init.mock.calls[0]![0] as Parameters<WorkerApi['init']>[0];
    expect(options.config).not.toHaveProperty('initSignal');
    expect(options.config).not.toHaveProperty('vfs');
    await handle.dispose();
  });
});

it('cancels a queued call without terminating an unrelated active run', async () => {
  let release!: (r: typeof result) => void;
  mocks.api.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const handle = await create();
  const active = handle.run({ args: ['active'] });
  const controller = new AbortController();
  const rejected = expect(
    handle.run({ args: ['queued'], signal: controller.signal }),
  ).rejects.toThrow('aborted');
  controller.abort();
  await rejected;
  expect(handle.isReady()).toBe(true);
  release(result);
  await active;
  await handle.run({ args: ['later'] });
  expect(mocks.api.run).toHaveBeenCalledTimes(2);
  await handle.dispose();
});
