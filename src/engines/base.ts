/**
 * Shared base for the typed engine wrappers.
 *
 * The wrapper classes are intentionally thin — they format argv, set sensible
 * defaults, and forward to engine.run(). Multi-pass orchestration lives in
 * `latexmk`, not here.
 */

import { createEngine } from '../core/engine';
import type {
  EngineConfig,
  EngineHandle,
  EngineId,
  FileInput,
  RunOptions,
  RunResult,
} from '../core/types';

export interface EngineWrapperOptions extends Omit<EngineConfig, 'useWorker'> {
  /** Reuse an existing handle instead of creating a new one. */
  engine?: EngineHandle;
  /** Pass to the underlying createEngine() if no handle is supplied. */
  useWorker?: boolean;
}

/**
 * Wall-clock ceiling for one engine invocation when the caller names none.
 * A runaway `\def\x{\x}\x` otherwise spins the worker forever, and on a
 * phone that is a dead app rather than a failed compile. Generous enough for
 * a large document on slow mobile hardware; pass `timeoutMs: 0` to opt out.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/** Per-invocation limits every typed wrapper accepts. */
export interface RunLimits {
  processEnv?: Record<string, string>;
  /**
   * Wall-clock ceiling in ms. Default: DEFAULT_RUN_TIMEOUT_MS. `0` disables
   * it. Enforcing it terminates the worker, so the handle (and any wrapper
   * that borrowed it) is unusable afterwards.
   */
  timeoutMs?: number;
  /** Cancels the run — same worker-terminating semantics as `timeoutMs`. */
  signal?: AbortSignal;
}

/** Pick just the limits out of a wrapper's option bag (exactOptionalPropertyTypes). */
export function limitsOf(options: RunLimits): RunLimits {
  return {
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

export abstract class BaseEngineWrapper {
  protected abstract readonly engineId: EngineId;
  protected handle: EngineHandle | null = null;

  constructor(protected options: EngineWrapperOptions = {}) {
    if (options.engine) this.handle = options.engine;
  }

  private loading: Promise<EngineHandle> | null = null;

  protected async ensureHandle(limits: RunLimits = {}): Promise<EngineHandle> {
    if (this.handle && (this.options.engine || this.handle.isReady())) return this.handle;
    if (this.loading) return this.loading;
    const { engine: _ignored, ...config } = this.options;
    void _ignored;
    const timeoutMs = limits.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.loading = createEngine(this.engineId, {
      ...config,
      initTimeoutMs:
        timeoutMs > 0
          ? config.initTimeoutMs && config.initTimeoutMs > 0
            ? Math.min(timeoutMs, config.initTimeoutMs)
            : timeoutMs
          : (config.initTimeoutMs ?? 0),
      ...(limits.signal ? { initSignal: limits.signal } : {}),
    });
    try {
      this.handle = await this.loading;
      return this.handle;
    } finally {
      this.loading = null;
    }
  }

  /** Drop the worker if this wrapper owns one. */
  async dispose(): Promise<void> {
    // Only dispose if we created the handle ourselves.
    if (this.handle && !this.options.engine) {
      await this.handle.dispose();
      this.handle = null;
    }
  }

  protected async runRaw(
    args: string[],
    files: FileInput[],
    extra: RunLimits & { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<RunResult> {
    if (extra.timeoutMs !== undefined && (!Number.isFinite(extra.timeoutMs) || extra.timeoutMs < 0))
      throw new Error('Invalid timeoutMs');
    const started = performance.now();
    if (extra.signal?.aborted) throw new Error('Engine run aborted');
    const handle = await this.ensureHandle(extra);
    const opts: RunOptions = {
      args,
      files,
      ...(extra.processEnv ? { processEnv: extra.processEnv } : {}),
      cwd: extra.cwd ?? '/project',
    };
    // 0 means "no ceiling"; undefined means "the caller did not think about
    // it", which is exactly when a default belongs.
    const timeoutMs = extra.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    if (timeoutMs > 0) {
      const remaining = Math.ceil(timeoutMs - (performance.now() - started));
      if (remaining <= 0) throw new Error('Engine invocation timed out during initialization');
      opts.timeoutMs = remaining;
    }
    if (extra.signal !== undefined) opts.signal = extra.signal;
    if (extra.env !== undefined) opts.env = extra.env;
    return handle.run(opts);
  }
}
