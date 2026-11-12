/**
 * Engine lifecycle manager: lazy, memoized handles with an LRU cap.
 *
 * Every engine worker holds its own copy of the TDS in memory (the map it
 * drains at init plus the materialization during runs), so keeping all seven
 * engines alive is expensive — on mobile WebViews it is fatal. The manager
 * keeps at most `maxLiveEngines` workers alive, evicting the least-recently-
 * used idle one before creating the next, and awaiting its disposal so the
 * old and new engine never hold their trees at the same time.
 *
 * "Idle" means nothing is using the engine: handles are pinned for the
 * duration of every run() and for the whole of a `withEngines()` scope, so a
 * compile can never have its engine — or a helper it is about to need —
 * evicted underneath it. When everything is pinned the cap is exceeded rather
 * than deadlocking: a latexmk pipeline legitimately needs tex + bibtex +
 * makeindex + xdvipdfmx alive together, and blocking it to satisfy a memory
 * cap would hang the compile instead of slowing it.
 */

import { createEngine } from './engine';
import type { EngineConfig, EngineHandle, EngineId, RunOptions, RunResult } from './types';

export interface EngineManagerOptions {
  /** Builds the EngineConfig for an engine the first time it is needed. */
  config: (id: EngineId) => EngineConfig;
  /**
   * Maximum live engine workers. Default: 3 — a desktop-browser trade-off.
   * Mobile WebViews (Tauri iOS/Android) should use 1: one live worker is
   * roughly "TDS bytes + wasm heap" of resident memory.
   */
  maxLiveEngines?: number;
  /** Diagnostics: an idle engine was evicted to make room. */
  onEvict?: (id: EngineId) => void;
  /** Diagnostics: a new engine worker starts loading. */
  onLoad?: (id: EngineId) => void;
}

export interface EngineManager {
  /**
   * Lazy, memoized handle; marks the engine most-recently-used. The handle is
   * leased: it pins its engine for the duration of each run(), and its
   * dispose() goes through the manager so the slot cannot outlive the worker.
   */
  engine(id: EngineId): Promise<EngineHandle>;
  /**
   * Acquire several engines and pin them for the duration of `fn` — a
   * multi-engine pipeline (latexmk: tex + bibtex + makeindex + xdvipdfmx)
   * must not have a helper evicted mid-run by another compile.
   */
  withEngines<T>(
    ids: EngineId[],
    fn: (handles: Map<EngineId, EngineHandle>) => Promise<T>,
  ): Promise<T>;
  /** Engines currently alive (loaded or still loading). */
  live(): EngineId[];
  /** Dispose one engine, or every engine when no id is given. */
  dispose(id?: EngineId): Promise<void>;
}

interface Slot {
  /** The raw handle from createEngine. */
  promise: Promise<EngineHandle>;
  /** The leased view handed to callers — stable per slot. */
  leased: Promise<EngineHandle>;
  /** The resolved handle, once it exists — isReady() has to answer synchronously. */
  current: EngineHandle | null;
  pins: number;
  lastUsed: number;
}

/** A slot that never loaded is handled by `forget`; this just keeps it unhandled-free. */
function noop(): void {}

export function createEngineManager(options: EngineManagerOptions): EngineManager {
  const maxLive = options.maxLiveEngines ?? 3;
  if (!Number.isSafeInteger(maxLive) || maxLive < 1)
    throw new Error('maxLiveEngines must be a positive integer');
  const slots = new Map<EngineId, Slot>();
  let clock = 0;

  function get(id: EngineId): Slot {
    const existing = slots.get(id);
    if (existing && (!existing.current || existing.current.isReady())) {
      existing.lastUsed = ++clock;
      return existing;
    }
    // Synchronous slot creation is load-bearing: withEngines() pins its slots
    // before it awaits anything, so a concurrent compile cannot evict a
    // handle that is still being constructed.
    if (existing) slots.delete(id);
    const evicted = existing ? existing.promise.then((h) => h.dispose()) : evictIdle();
    options.onLoad?.(id);
    const promise = evicted.then(() => createEngine(id, options.config(id)));
    const slot: Slot = {
      promise,
      leased: promise.then((handle) => lease(id, handle)),
      current: null,
      pins: 0,
      lastUsed: ++clock,
    };
    slots.set(id, slot);
    promise.then((handle) => {
      slot.current = handle;
    }, noop);
    // A failed init must not poison the slot forever.
    const forget = () => {
      if (slots.get(id) === slot) slots.delete(id);
    };
    promise.catch(forget);
    slot.leased.catch(forget);
    return slot;
  }

  /**
   * Free a slot for the engine about to be created. The returned promise
   * settles only once the victim's worker is actually gone — starting the new
   * engine before that would put both trees in memory at once, which is the
   * peak the cap exists to prevent.
   */
  function evictIdle(): Promise<void> {
    if (slots.size < maxLive) return Promise.resolve();
    let victim: EngineId | null = null;
    let oldest = Infinity;
    for (const [id, slot] of slots) {
      if (slot.pins === 0 && slot.lastUsed < oldest) {
        oldest = slot.lastUsed;
        victim = id;
      }
    }
    if (!victim) return Promise.resolve(); // everything is pinned — allow the extra engine
    const slot = slots.get(victim)!;
    slots.delete(victim);
    options.onEvict?.(victim);
    return slot.promise.then(
      (h) => h.dispose(),
      () => {}, // a slot that never loaded has nothing to dispose
    );
  }

  async function trimIdle(): Promise<void> {
    while (slots.size > maxLive) {
      const size = slots.size;
      await evictIdle();
      if (slots.size === size) break;
    }
  }

  /**
   * Wrap a handle so that using it keeps it alive. Without this an engine
   * obtained from engine() is unpinned while it runs, so a concurrent compile
   * can evict it mid-run — and terminating a worker mid-callMain is exactly
   * the case that leaves the caller's run() promise unsettled.
   *
   * The lease is on the engine ID, not on one worker: it re-acquires the slot
   * on every run and pins it BEFORE awaiting anything. So a handle whose worker
   * was evicted between two compiles transparently gets a fresh one, instead of
   * throwing "has been disposed" at a caller who did nothing wrong.
   */
  function lease(id: EngineId, handle: EngineHandle): EngineHandle {
    return {
      id: handle.id,
      config: handle.config,
      async run(runOptions: RunOptions): Promise<RunResult> {
        const slot = get(id);
        slot.pins++;
        try {
          const live = await slot.promise;
          return await live.run(runOptions);
        } finally {
          slot.pins--;
          await trimIdle();
        }
      },
      // Disposing the worker behind the manager's back would leave the slot
      // handing out a dead handle.
      dispose: () => manager.dispose(id),
      // Answer for the engine the next run() would use, not for the worker
      // this lease was minted around: that one may have been evicted since,
      // and run() would transparently reload it. Reporting the dead worker
      // would have a leased handle claim "not ready" forever after an
      // eviction it is designed to survive.
      isReady: () => slots.get(id)?.current?.isReady() ?? false,
    };
  }

  const manager: EngineManager = {
    engine: (id) => get(id).leased,

    async withEngines(ids, fn) {
      // Pin before awaiting anything so a concurrent compile can't evict a
      // handle we are still constructing.
      const pinned = ids.map((id) => {
        const slot = get(id);
        slot.pins++;
        return slot;
      });
      try {
        const handles = new Map<EngineId, EngineHandle>();
        for (let i = 0; i < ids.length; i++) {
          handles.set(ids[i]!, await pinned[i]!.leased);
        }
        return await fn(handles);
      } finally {
        for (const slot of pinned) slot.pins--;
        await trimIdle();
      }
    },

    live: () => [...slots.keys()],

    async dispose(id) {
      const targets = id ? [id] : [...slots.keys()];
      await Promise.allSettled(
        targets.map((t) => {
          const slot = slots.get(t);
          if (!slot) return Promise.resolve();
          slots.delete(t);
          return slot.promise.then((h) => h.dispose());
        }),
      );
    },
  };

  return manager;
}
