/**
 * The dogfooding layer: everything the showcase does with TeX goes through
 * the actual `texlive-wasm` npm API from here — incremental compile sessions with
 * per-engine Web Workers, exactly as a consumer app would use it.
 */

import { createCompileSession } from '@typeward/texlive-wasm';
import type { EngineId, FileInput, LatexmkEngine, LatexmkResult, CompileEvent } from '@typeward/texlive-wasm';
import { createSignal } from 'solid-js';

/** Human-readable artifact sizes for status messages (see README table). */
export const ENGINE_SIZES: Record<EngineId, string> = {
  pdflatex: '1.3 MB',
  xelatex: '2.8 MB',
  lualatex: '4.8 MB',
  bibtexu: '0.9 MB',
  xdvipdfmx: '0.8 MB',
  makeindex: '0.2 MB',
  biber: '9.1 MB + 14 MB VFS',
};

/**
 * Runtime assets live under core/ next to index.html (vite middleware in dev,
 * files staged by deploy-site.yml on Pages). URLs must be absolute because
 * the library worker resolves enginePath against the *worker script* URL.
 */
const coreUrl = (p: string) => new URL(`core/${p}`, document.baseURI).href;

export const [engineStatus, setEngineStatus] = createSignal<string>('');
export const [tdsProgress, setTdsProgress] = createSignal<{
  loaded: number;
  total: number;
} | null>(null);
export const [tdsReady, setTdsReady] = createSignal(false);

/**
 * Warm the browser HTTP cache for the TDS bundle with a byte-accurate
 * progress bar. The engine workers then fetch the same URL themselves
 * (EngineConfig.bundleUrl) and hit the cache instead of the network.
 */
let tdsWarm: Promise<void> | null = null;
export function warmTds(): Promise<void> {
  tdsWarm ??= (async () => {
    const url = coreUrl('texmf.tar.gz');
    const r = await fetch(url);
    if (!r.ok) {
      throw new Error(
        `TDS bundle missing (HTTP ${r.status} for core/texmf.tar.gz). ` +
          `See demo/README.md for how to stage the runtime assets.`,
      );
    }
    const total = Number(r.headers.get('content-length') ?? 0);
    if (r.body && total > 0) {
      const reader = r.body.getReader();
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        setTdsProgress({ loaded, total });
      }
    } else {
      await r.arrayBuffer();
    }
    setTdsProgress(null);
    setTdsReady(true);
  })().catch((err) => {
    tdsWarm = null; // allow retry on the next compile
    setTdsProgress(null);
    throw err;
  });
  return tdsWarm;
}

const session = createCompileSession({
  resourceVersion: 'demo-pinned-tds',
  maxLiveEngines: 3,
  onLoad: (id) => setEngineStatus(`loading ${id}.wasm (${ENGINE_SIZES[id]})…`),
  config: (id) => ({
    enginePath: coreUrl(`${id}/emscripten/${id}.wasm`),
    bundleUrl:
      id === 'biber' ? coreUrl('biber/emscripten/biber-vfs.tar.gz') : coreUrl('texmf.tar.gz'),
    ...(id === 'xelatex' || id === 'bibtexu' ? { icuDataUrl: coreUrl('icudt78l.dat') } : {}),
  }),
});

export interface CompileRequest {
  engine: LatexmkEngine;
  mainTex: string;
  files: FileInput[];
  synctex?: boolean;
  preview?: boolean;
  onEvent?: (event: CompileEvent) => void;
}

/** Incremental edits use the same public session API recommended to consumers. */
export async function compile(req: CompileRequest): Promise<LatexmkResult> {
  await warmTds();
  setEngineStatus(`preparing and compiling with ${req.engine}…`);
  const result = await session.compile({ ...req, strict: true, rerun: 'auto' });
  setEngineStatus(
    result.success
      ? `done — ${result.passes} pass(es)`
      : result.diagnostics.length
        ? result.diagnostics[0]!.message
        : `failed (exit ${result.exitCode})`,
  );
  return result;
}
