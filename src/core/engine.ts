/**
 * createEngine — public entry point for the low-level API.
 *
 * Spins up a Web Worker per engine instance and proxies all calls via Comlink.
 * The worker loads the engine .wasm, sets up the FS with the configured VFS
 * backend chain, and exposes a typed RPC surface.
 */

import * as Comlink from 'comlink';
import type {
  EngineConfig,
  EngineHandle,
  EngineId,
  RunOptions,
  RunResult,
  VfsBackend,
} from './types';
import { defaultBackends } from '../vfs';
import type { BackendHost, BackendMeta, WorkerApi } from './worker';

const DEFAULT_CONFIG: Required<Pick<EngineConfig, 'useWorker' | 'verbose'>> = {
  useWorker: typeof Worker !== 'undefined',
  verbose: 'silent',
};

/** How long dispose() waits for the worker to acknowledge before terminating it. */
const DISPOSE_GRACE_MS = 2000;

export async function createEngine(id: EngineId, config: EngineConfig = {}): Promise<EngineHandle> {
  const controller = new AbortController();
  const timeoutMs = config.initTimeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid initTimeoutMs');
  const abort = () => controller.abort(config.initSignal?.reason);
  config.initSignal?.addEventListener('abort', abort, { once: true });
  if (config.initSignal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(`Engine ${id}: initialization aborted or timed out`));
    controller.signal.addEventListener('abort', fail, { once: true });
    if (controller.signal.aborted) fail();
  });
  if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      initializeEngine(id, { ...config, initSignal: controller.signal }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    config.initSignal?.removeEventListener('abort', abort);
  }
}

async function initializeEngine(id: EngineId, config: EngineConfig): Promise<EngineHandle> {
  const merged: EngineConfig = { ...DEFAULT_CONFIG, ...config };
  if (!merged.useWorker && typeof process !== 'undefined' && process.versions?.node) {
    return createInProcessEngine(id, merged);
  }
  // With a worker, the manifest's core bundle is unpacked inside it (see
  // WorkerInitOptions.bundleFromManifest) — building it out here would keep a
  // second copy of the whole TeX tree on the main thread and then trickle it
  // across the RPC boundary file by file.
  const bundleInWorker = !merged.vfs && !!merged.manifestUrl;
  const backends: VfsBackend[] =
    merged.vfs ?? (await defaultBackends(id, merged, { skipManifestBundle: bundleInWorker }));

  if (config.initSignal?.aborted) throw new Error(`Engine ${id}: initialization aborted`);
  if (merged.useWorker) {
    return createWorkerEngine(id, merged, backends, bundleInWorker);
  }
  return createInProcessEngine(id, merged, backends);
}

/**
 * Comlink only converts a value into a live proxy when it is a *top-level*
 * argument or return value — proxy markers nested inside a plain object are
 * structured-cloned instead (and objects with function properties throw
 * DataCloneError). So the backend chain crosses the worker boundary as ONE
 * top-level proxied "host" object that dispatches by index, plus a cloneable
 * capability list so the worker knows which optional methods exist.
 */
function makeBackendHost(backends: VfsBackend[]): BackendHost {
  return {
    async read(i: number, tdsPath: string): Promise<Uint8Array | null> {
      return (await backends[i]!.read(tdsPath)) ?? null;
    },
    async exists(i: number, tdsPath: string): Promise<boolean> {
      const b = backends[i]!;
      if (b.exists) return b.exists(tdsPath);
      return (await b.read(tdsPath)) != null;
    },
    async list(i: number, tdsPrefix: string): Promise<string[]> {
      const b = backends[i]!;
      return b.list ? await b.list(tdsPrefix) : [];
    },
    async init(i: number): Promise<void> {
      await backends[i]!.init?.();
    },
    async dispose(i: number): Promise<void> {
      await backends[i]!.dispose?.();
    },
  };
}

export async function createWorkerEngine(
  id: EngineId,
  config: EngineConfig,
  backends: VfsBackend[],
  bundleFromManifest = false,
  suppliedWorker?: Comlink.Endpoint & { terminate(): void },
): Promise<EngineHandle> {
  // Vite requires Worker options to be statically analyzable; keep the object literal inline.
  const worker =
    suppliedWorker ??
    new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'texlive-wasm-worker',
    });
  // Comlink never rejects on worker load failure — surface it ourselves so
  // createEngine() rejects instead of hanging forever.
  const workerFailed = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => {
      const msg = (event as ErrorEvent).message || 'worker failed';
      reject(new Error(`texlive-wasm: engine worker error: ${msg}`));
    });
    worker.addEventListener('messageerror', () => {
      reject(new Error('texlive-wasm: engine worker message could not be deserialized'));
    });
  });
  const api = Comlink.wrap<WorkerApi>(worker);
  workerFailed.catch(() => {});

  // config.vfs holds objects with methods — not structured-cloneable. The
  // worker never needs it (it gets the host proxy instead), so strip it.
  const { vfs: _vfs, initSignal: _initSignal, ...cloneableConfig } = config;
  const backendMeta: BackendMeta[] = backends.map((b) => ({
    id: b.id,
    hasList: typeof b.list === 'function',
    hasInit: typeof b.init === 'function',
    hasDispose: typeof b.dispose === 'function',
  }));

  let rejectInit: (error: Error) => void = () => {};
  const initAborted = new Promise<never>((_, reject) => {
    rejectInit = reject;
  });
  const abortInit = () => {
    worker.terminate();
    rejectInit(new Error('Engine initialization aborted'));
  };
  config.initSignal?.addEventListener('abort', abortInit, { once: true });
  try {
    if (config.initSignal?.aborted) throw new Error('Engine initialization aborted');
    await Promise.race([
      api.init(
        {
          engineId: id,
          config: cloneableConfig,
          backendMeta,
          ...(bundleFromManifest ? { bundleFromManifest: true } : {}),
        },
        Comlink.proxy(makeBackendHost(backends)),
      ),
      workerFailed,
      initAborted,
    ]);
  } catch (err) {
    worker.terminate();
    throw err;
  } finally {
    config.initSignal?.removeEventListener('abort', abortInit);
  }

  let ready = true;
  // Serialize run() calls: the worker executes callMain synchronously and
  // interleaved lazy-fetch awaits from two concurrent runs would corrupt
  // each other's /project state.
  let queue: Promise<unknown> = Promise.resolve();

  // Killing the worker leaves the in-flight Comlink call unsettled forever —
  // its reply can never arrive. Every path that terminates the worker settles
  // this instead, so a caller awaiting run() gets an error rather than a hang.
  let killRun: (err: Error) => void = () => {};
  const killed = new Promise<never>((_, reject) => {
    killRun = reject;
  });
  killed.catch(() => {}); // nobody races it while the worker is healthy

  const terminate = (reason: string): void => {
    ready = false;
    worker.terminate();
    killRun(new Error(`Engine ${id}: ${reason}`));
  };

  void workerFailed.catch((err: Error) => terminate(err.message));

  const doRun = async (options: RunOptions): Promise<RunResult> => {
    if (!ready) throw new Error(`Engine ${id} has been disposed`);
    const { signal: _signal, ...runOptions } = options;
    return Promise.race([api.run(runOptions), killed]);
  };

  return {
    id,
    config,
    async run(options: RunOptions): Promise<RunResult> {
      if (!ready) throw new Error(`Engine ${id} has been disposed`);
      if (options.signal?.aborted) throw new Error(`Engine ${id}: run aborted before it started`);
      if (
        options.timeoutMs !== undefined &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
      ) {
        throw new Error('Invalid timeoutMs');
      }
      let running = false;
      let cancellation: Error | undefined;
      let rejectCancelled: (error: Error) => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = reject;
      });
      const cancel = (reason: string) => {
        cancellation = new Error(`Engine ${id}: ${reason}`);
        if (running) terminate(reason);
        rejectCancelled(cancellation);
      };
      const onAbort = () => cancel('run aborted');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(
              () => cancel(`run exceeded timeoutMs=${options.timeoutMs}`),
              options.timeoutMs,
            )
          : undefined;
      const result = queue.then(async () => {
        if (cancellation) throw cancellation;
        running = true;
        try {
          return await doRun(options);
        } finally {
          running = false;
        }
      });
      queue = result.catch(() => {});
      try {
        return await Promise.race([result, cancelled, killed]);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    },
    async dispose(): Promise<void> {
      if (!ready) return;
      ready = false;
      let disposeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A worker stuck in synchronous callMain never answers — don't let
        // dispose() hang on it.
        await Promise.race([
          api.dispose(),
          new Promise((resolve) => {
            disposeTimer = setTimeout(resolve, DISPOSE_GRACE_MS);
          }),
        ]);
      } finally {
        clearTimeout(disposeTimer);
        worker.terminate();
        killRun(new Error(`Engine ${id} was disposed while a run was in flight`));
      }
    },
    isReady(): boolean {
      return ready;
    },
  };
}

async function createInProcessEngine(
  id: EngineId,
  config: EngineConfig,
  backends?: VfsBackend[],
): Promise<EngineHandle> {
  if (typeof process !== 'undefined' && process.versions?.node) {
    // Keep Node built-ins out of browser bundles. Both files ship in dist/.
    const entry = './node.js';
    const { initializeNodeEngine } = (await import(
      /* @vite-ignore */ entry
    )) as typeof import('../node');
    return initializeNodeEngine(id, config, backends);
  }
  throw new Error(
    'texlive-wasm: this host requires Web Workers; useWorker:false is only supported in Node',
  );
}
