/** Node execution uses a worker thread, preserving cancellation and isolation. */
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createEngine, createWorkerEngine } from './core/engine';
import { defaultBackends } from './vfs';
import { nodeEndpoint } from './core/node-endpoint';
import type { EngineConfig, EngineHandle, EngineId, VfsBackend } from './core/types';

export async function initializeNodeEngine(
  id: EngineId,
  config: EngineConfig = {},
  suppliedBackends?: VfsBackend[],
): Promise<EngineHandle> {
  const normalized = { ...config };
  for (const key of ['enginePath', 'fmtPath', 'bundleUrl', 'manifestUrl', 'icuDataUrl'] as const) {
    const value = config[key];
    if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value))
      normalized[key] = pathToFileURL(resolve(value)).href;
  }
  const backends =
    suppliedBackends ??
    config.vfs ??
    (await defaultBackends(id, normalized, { skipManifestBundle: true }));
  if (config.initSignal?.aborted) throw new Error('Engine initialization aborted');
  const entry = 'node-worker.js';
  const thread = new Worker(new URL(entry, import.meta.url));
  const endpoint = nodeEndpoint(thread);
  const errors = new Map<EventListenerOrEventListenerObject, (error: Error) => void>();
  const adapter = {
    ...endpoint,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'error' || type === 'messageerror') {
        const wrapped = (error: Error) => {
          const event = Object.assign(new Event(type), { message: error.message });
          if (typeof listener === 'function') listener(event);
          else listener.handleEvent(event);
        };
        errors.set(listener, wrapped);
        thread.on(type, wrapped);
        if (type === 'error')
          thread.on('exit', (code) => wrapped(new Error(`worker exited (${code})`)));
      } else endpoint.addEventListener(type, listener);
    },
    terminate: () => {
      void thread.terminate();
    },
  };
  return createWorkerEngine(id, normalized, backends, !config.vfs && !!config.manifestUrl, adapter);
}

export function createNodeEngine(id: EngineId, config: EngineConfig = {}): Promise<EngineHandle> {
  return createEngine(id, { ...config, useWorker: false });
}

export { latexmk } from './latexmk';
export type { EngineConfig, EngineHandle, EngineId, RunOptions, RunResult } from './core/types';
