/**
 * texlive-wasm — public API.
 *
 * Three layers:
 *   1. Low level:  createEngine() → run() — direct argv invocation.
 *   2. Mid level:  Engine wrappers (PdfLatex, XeLatex, LuaLatex) — typed args.
 *   3. High level: latexmk() — multi-pass driver with auto bibtex/makeindex/rerun detection.
 *
 * The Tauri integration ('texlive-wasm/tauri') is a separate entry point so
 * web-only consumers don't pull in @tauri-apps/plugin-fs.
 */

export { createEngine } from './core/engine';
export { createEngineManager } from './core/manager';
export type { EngineManager, EngineManagerOptions } from './core/manager';
export { latexmk, willRunBibtex, willRunBiber, willRunMakeindex } from './latexmk';
export { PdfLatex } from './engines/pdflatex';
export { XeLatex } from './engines/xelatex';
export { LuaLatex } from './engines/lualatex';
export { Bibtexu } from './engines/bibtexu';
export { Biber } from './engines/biber';
export { Makeindex } from './engines/makeindex';
export { Xdvipdfmx } from './engines/xdvipdfmx';
export { createSynctex } from './synctex';

export { loadManifest, expectedSha256, sha256Hex } from './core/manifest';

export type {
  EngineId,
  EngineConfig,
  EngineHandle,
  RunOptions,
  RunResult,
  FileInput,
  CompileResult,
  LogEntry,
  VfsBackend,
} from './core/types';

export type { LatexmkOptions, LatexmkResult, LatexmkEngine } from './latexmk';

export type { EngineWrapperOptions, RunLimits } from './engines/base';
export { DEFAULT_RUN_TIMEOUT_MS } from './engines/base';
export type { PdfLatexCompileOptions } from './engines/pdflatex';
export type { XeLatexCompileOptions } from './engines/xelatex';
export type { LuaLatexCompileOptions } from './engines/lualatex';
export type { BibtexuOptions } from './engines/bibtexu';
export type { BiberOptions } from './engines/biber';
export type { MakeindexOptions } from './engines/makeindex';
export type { XdvipdfmxOptions } from './engines/xdvipdfmx';

export type { BundleFsOptions } from './vfs/bundlefs';
export type { FetchFsOptions } from './vfs/fetchfs';
export type { OpfsFsOptions } from './vfs/opfsfs';
export { createBundleFs, createFetchFs, createOpfsFs, defaultBackends, withIntegrity } from './vfs';
export type { DefaultBackendsOptions } from './vfs';

export type { TexPackagesManifest, ManifestEntry, ManifestTier } from './core/manifest';

export type { SynctexLookup, SynctexForwardHit, SynctexReverseHit } from './synctex';
