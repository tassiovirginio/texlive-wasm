/**
 * Local glue around `texlive-wasm` for this Tauri example.
 *
 * In a web build the engine .wasm is fetched over HTTP from
 * /texlive-wasm/ (staged into public/ by scripts/ensure-assets.mjs) and
 * TDS files come from the same tree, drained on demand.
 *
 * In a Tauri build the same wrapper is reused, but a TauriFS backend is
 * prepended so the engine reads TDS files straight off disk via
 * @tauri-apps/plugin-fs — no network, no OPFS copy.
 */

import { createEngine, PdfLatex as _PdfLatex } from '@typeward/texlive-wasm';
import { withTauriFs, isTauri } from '@typeward/texlive-wasm/tauri';
import type { EngineConfig, EngineHandle, VfsBackend } from '@typeward/texlive-wasm';
import type { PdfLatexCompileOptions, RunResult } from '@typeward/texlive-wasm';

// BaseDirectory.Resource in Tauri 2 (@tauri-apps/api/path). Kept as a
// number so the web build doesn't import the Tauri API.
const TAURI_RESOURCE = 11;

class TauriAwarePdfLatex extends _PdfLatex {
  /** Resolves once the TauriFS-backed handle is attached (Tauri only). */
  private tauriInit: Promise<void> | null = null;
  private texmfRoot = 'texlive-wasm/texmf';

  constructor(config: EngineConfig & { texmfRoot?: string } = {}) {
    const { texmfRoot, ...cfg } = config;
    super(cfg);
    if (isTauri()) {
      // The TDS is bundled under $RESOURCE/texlive-wasm/texmf (see
      // tauri.conf.json bundle.resources).
      this.texmfRoot = texmfRoot ?? this.texmfRoot;
      this.tauriInit = this.initTauriHandle(cfg, this.texmfRoot);
      void this.tauriInit.catch(() => {});
    }
  }

  override async compile(options: PdfLatexCompileOptions): Promise<RunResult> {
    // Wait for the TauriFS handle before the base class lazily creates a
    // plain one — otherwise the first compile races the backend setup.
    if (isTauri() && !this.handle?.isReady() && !this.tauriInit) {
      this.tauriInit = this.initTauriHandle(this.options, this.texmfRoot);
    }
    if (this.tauriInit) {
      try { await this.tauriInit; } finally { this.tauriInit = null; }
    }
    return super.compile(options);
  }

  private async initTauriHandle(cfg: EngineConfig, texmfRoot: string): Promise<void> {
    // Preload the per-engine CORE bundle when it is staged (pack-tds.mjs
    // --tier core --engine pdflatex → copied by ensure-assets). Without it
    // the first pass starts against an empty /texmf-dist and leans entirely
    // on the on-miss retry — slow at best, fragile for real documents.
    const coreBundle = await probeCoreBundle('pdflatex');
    const handle: EngineHandle = await withTauriFs(
      (vfs: VfsBackend[]) =>
        createEngine('pdflatex', { ...cfg, ...(coreBundle ? { bundleUrl: coreBundle } : {}), vfs }),
      { texmfRoot, baseDir: TAURI_RESOURCE },
    );
    this.handle = handle;
  }
}

async function probeCoreBundle(engine: string): Promise<string | undefined> {
  const url = new URL(`texlive-wasm/texmf-core-${engine}.tar.gz`, document.baseURI).href;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok ? url : undefined;
  } catch {
    return undefined;
  }
}

export const PdfLatex = TauriAwarePdfLatex;
// Type alias so `let engine: PdfLatex` works — the export above is a value.
export type PdfLatex = TauriAwarePdfLatex;
export { isTauri };
export type { RunResult } from '@typeward/texlive-wasm';
