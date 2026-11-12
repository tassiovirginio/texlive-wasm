import { parentPort } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { WorkerImpl } from './core/worker';
import { nodeEndpoint } from './core/node-endpoint';
if (!parentPort) throw new Error('texlive-wasm: node-worker must run in a worker thread');
Comlink.expose(new WorkerImpl(), nodeEndpoint(parentPort));
