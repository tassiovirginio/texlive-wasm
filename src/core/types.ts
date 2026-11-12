/**
 * Shared type definitions.
 */

export type EngineId =
  | 'pdflatex'
  | 'xelatex'
  | 'lualatex'
  | 'bibtexu'
  | 'xdvipdfmx'
  | 'makeindex'
  | 'biber';

export interface EngineConfig {
  /** Initialization deadline, including downloads. Default: 300000 ms; 0 disables. */
  initTimeoutMs?: number;
  /** Abort initialization; never sent across the worker boundary. */
  initSignal?: AbortSignal;
  /** URL or absolute path of the engine `.wasm` artifact. */
  enginePath?: string;
  /** URL or absolute path of the engine's pre-built `.fmt` file (LaTeX format). */
  fmtPath?: string;
  /** URL or absolute path of the `tex-packages.json` manifest. */
  manifestUrl?: string;
  /**
   * URL of a core TDS tarball (`.tar.gz` / `.tar.br` / plain `.tar`). The
   * engine worker fetches and unpacks it itself at init (a BundleFS is
   * created worker-side), so repeated engine instances share the browser
   * HTTP cache instead of shipping file bytes over the RPC boundary.
   */
  bundleUrl?: string;
  /** Additive, integrity-pinned language/font bundles. Base files win on conflict. */
  resourcePacks?: { url: string; sha256: string }[];
  /**
   * SHA-256 (hex) of the bundle at `bundleUrl`. Required for a cross-origin
   * bundle: those bytes are the entire TeX tree the engine executes. A bundle
   * named by a manifest carries its digest there (`coreBundleSha256`) and
   * needs nothing here.
   */
  bundleSha256?: string;
  /**
   * Load assets that nothing pins: a cross-origin bundle with no SHA-256, and
   * cached/CDN files when no manifest is available to check them against.
   * Default: false. Development escape hatch — in production a bundle is
   * either same-origin, digest-pinned, or not loaded.
   */
  allowUnverifiedAssets?: boolean;
  /**
   * URL of `icudt78l.dat` (ICU locale data). Only used by ICU engines
   * (xelatex, bibtexu); without it, locale-specific ICU APIs return
   * U_MISSING_RESOURCE_ERROR but basic operation still works.
   */
  icuDataUrl?: string;
  /** When supplied, FETCHFS uses this as the CDN base for long-tail packages. */
  cdnBaseUrl?: string;
  /**
   * Carry engine-written caches under /tmp/texmf-var (luaotfload's font-name
   * database, etc.) across runs of the same engine handle. Default: true.
   * The cache lives in the worker, so it never outlives the TDS it was
   * built from. Set false to give every run a pristine cache dir.
   */
  persistTexmfVar?: boolean;
  /**
   * Mount the TeX tree lazily (default: true on engines built with the
   * wasmfs-lazy backend): file bytes stay on the JS side and are copied
   * into the wasm heap only when the engine reads them — instead of
   * materializing the entire tree into MEMFS per run. Set false to force
   * eager materialization. Ignored (always eager) for biber and for
   * artifacts without the backend.
   */
  lazyTds?: boolean;
  /** Worker-local project blob cache limit (default 64 MiB); 0 disables delta transfer. */
  projectCacheBytes?: number;
  /** Whether to use a Web Worker (default: true in browser, false in Node). */
  useWorker?: boolean;
  /** Verbosity for engine stdout/stderr piped through the wrapper. */
  verbose?: 'silent' | 'info' | 'debug';
  /**
   * Optional explicit VFS layer chain. If omitted, defaults to
   * [BundleFS(core), TauriFS or OPFS if available, FETCHFS if cdnBaseUrl set].
   */
  vfs?: VfsBackend[];
}

export interface FileInput {
  /** Path inside `/project` (relative). */
  path: string;
  content: string | Uint8Array;
}

export interface RunOptions {
  /** argv after the program name. e.g. ['--no-shell-escape', 'main.tex']. */
  args: string[];
  /** Files dropped into /project before the engine starts. */
  files?: FileInput[];
  /** Internal complete project manifest for delta worker transport. */
  fileRefs?: import('./blobs').InputReference[];
  fileBlobs?: import('./blobs').InputBlob[];
  /** Working directory inside the engine. Default: `/project`. */
  cwd?: string;
  /** stdin payload, encoded as UTF-8 when a string is supplied. */
  stdin?: string | Uint8Array;
  /**
   * kpathsea variable overrides (TEXINPUTS, TEXMFCNF, ...). Injected as
   * `-cnf-line=KEY=VAL` args for the TeX engines; ignored for bibtexu,
   * xdvipdfmx and makeindex (Emscripten freezes real env vars at init).
   */
  env?: Record<string, string>;
  /** Actual libc process variables, applied before main (requires v0.4+ engine). */
  processEnv?: Record<string, string>;
  /**
   * Maximum wall-clock time before the run is aborted, in ms. The engine
   * runs synchronously inside its worker, so aborting terminates the worker
   * — the handle is unusable afterwards and must be recreated.
   */
  timeoutMs?: number;
  /**
   * Cancels the run. Like `timeoutMs`, cancellation terminates the worker
   * (callMain cannot be interrupted), so the handle is unusable afterwards.
   * Consumed on the main thread — an AbortSignal is not structured-cloneable
   * and never crosses the worker boundary.
   */
  signal?: AbortSignal;
  /**
   * If true (default), the worker parses missing-file errors out of the .log
   * after a failed compile, asks the VFS backends for those paths, writes
   * them into MEMFS, and retries the compile up to eight times. Set false to disable, or
   * `{ maxRetries }` to allow more rounds — useful when lazily-fetched
   * packages `\RequirePackage` further missing files and the backends are
   * cheap to consult (local TauriFS reads, warm OPFS cache).
   */
  lazyFetch?: boolean | { maxRetries?: number };
}

export interface RunResult {
  /** Worker acknowledgement; file hashes only, no project paths. */
  inputCache?: string[];
  inputTransport?: { sentBytes: number; reusedBytes: number };
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Files the engine PRODUCED under /project, keyed by path. Inputs the
   * caller supplied are not echoed back unless the engine rewrote them with
   * different bytes — on a multi-pass compile the project's images and fonts
   * would otherwise cross the worker boundary once per pass.
   */
  outputs: Map<string, Uint8Array>;
  /** Convenience: concatenated TeX `.log` if present. */
  log: string;
  /** Wall-clock duration of the engine invocation. */
  durationMs: number;
  /** How many lazy-fetch retries the worker had to perform. */
  lazyFetchRetries?: number;
  /**
   * Whether the TeX tree was mounted lazily (bytes stay JS-side) or copied
   * into the wasm heap eagerly. False means every instance paid for a full
   * TDS copy — the eager fallback is correct but costs hundreds of MB.
   */
  lazyTds?: boolean;
}

export interface LogEntry {
  durationMs?: number;
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
}

export interface CompileResult {
  success: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
  logs: LogEntry[];
  exitCode: number;
}

/**
 * A pluggable VFS backend mounted under `/texmf-dist`.
 *
 * Layers are consulted in order; the first one that resolves wins.
 * Implementations may be sync or async. Backends that expose list() are
 * drained into MEMFS when the engine initializes; the others are consulted
 * on demand by the lazy-fetch retry after a failed pass (see worker.ts).
 */
export interface VfsBackend {
  readonly id: string;
  /**
   * Returns the file contents if the backend has it, otherwise null.
   * Implementations should NOT throw on missing files.
   */
  read(tdsPath: string): Promise<Uint8Array | null> | Uint8Array | null;
  /** Optional verified package resolver for missing basenames; paths remain TDS-relative. */
  resolve?(name: string): Promise<{ path: string; content: Uint8Array }[]>;
  /** Cheap existence check; default is to attempt a read. */
  exists?(tdsPath: string): Promise<boolean> | boolean;
  /** Optional: enumerate all known paths under a TDS subtree. */
  list?(tdsPrefix: string): Promise<string[]> | string[];
  /** Optional: invoked once when the engine initializes. */
  init?(): Promise<void> | void;
  /** Optional: invoked when the engine is disposed. */
  dispose?(): Promise<void> | void;
}

export interface EngineHandle {
  readonly id: EngineId;
  readonly config: Readonly<EngineConfig>;
  /** Direct argv invocation. */
  run(options: RunOptions): Promise<RunResult>;
  /** Release the worker and any allocated WASM heap. */
  dispose(): Promise<void>;
  /** Whether the underlying worker/module has been instantiated. */
  isReady(): boolean;
}
