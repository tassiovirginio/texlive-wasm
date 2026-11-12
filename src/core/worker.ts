import { InputBlobCache } from './blobs';
import { fetchAsset } from './assets';
/**
 * Worker entry point. One Comlink-exposed instance per engine.
 *
 * The worker caches the engine's ES-module factory, the ICU data bytes and
 * the full TDS file map, and builds a FRESH Emscripten module instance for
 * every run(): TeX engines are not reentrant — a second callMain() on the
 * same instance misbehaves (static C state, getopt position and kpathsea
 * caches survive the first run; observed as wrong exit codes and wasm
 * "index out of bounds" traps). Instance setup costs an instantiation plus
 * repopulating MEMFS from the cached map, which is what correctness costs.
 *
 * Compile-time mandates we worked around:
 * - kpathsea overrides use texmf.cnf; processEnv uses the exported libc setter.
 *   Legacy configuration keeps using TL's
 *   `-cnf-line=KEY=VAL` args which inject texmf.cnf settings at runtime.
 * - kpathsea search paths derive from $SELFAUTOPARENT (= dirname(thisProgram));
 *   we use thisProgram='/bin/<engine>' so /texmf-dist/web2c is in the cnf path.
 * - ICU's libicudata.a archive members are ELF; we link a stub icudt78_dat
 *   and JS-side load icudt78l.dat via _udata_setCommonData_78 for ICU engines.
 * - VFS backends live in the main thread. Comlink can only proxy top-level
 *   arguments, so they arrive as ONE proxied "host" object (dispatch by
 *   index) plus a cloneable capability list (see BackendHost/BackendMeta).
 */

import * as Comlink from 'comlink';
import type { EngineConfig, EngineId, RunOptions, RunResult, VfsBackend } from './types';
import { createBundleFs } from '../vfs/bundlefs';
import { loadManifest } from './manifest';
import { buildLsR } from './lsr';
import { safeRelativePath, safeResolve } from './paths';

/** Cloneable capability descriptor for one VFS backend. */
export interface BackendMeta {
  id: string;
  hasList: boolean;
  hasResolve?: boolean;
  hasInit: boolean;
  hasDispose: boolean;
}

/**
 * Main-thread dispatcher for the whole backend chain. Passed to init() as a
 * top-level Comlink proxy (nested proxies are not supported by Comlink).
 */
export interface BackendHost {
  resolve?(index: number, name: string): Promise<{ path: string; content: Uint8Array }[]>;
  read(index: number, tdsPath: string): Promise<Uint8Array | null>;
  exists(index: number, tdsPath: string): Promise<boolean>;
  list(index: number, tdsPrefix: string): Promise<string[]>;
  init(index: number): Promise<void>;
  dispose(index: number): Promise<void>;
}

export interface WorkerInitOptions {
  engineId: EngineId;
  /** Structured-cloneable subset of EngineConfig (no `vfs`). */
  config: EngineConfig;
  /** Capability list, index-aligned with the BackendHost dispatcher. */
  backendMeta?: BackendMeta[];
  /** Optional: bytes of `icudt78l.dat`. Required for xelatex + bibtexu locale ops. */
  icuData?: Uint8Array;
  /**
   * Build the manifest's core BundleFS in here rather than on the main
   * thread. Set by createEngine when it owns the backend chain: a
   * main-thread BundleFS would hold the whole TDS twice (once per side) and
   * ship every one of its ~17k files across the RPC boundary one read at a
   * time. Not set when the caller supplied an explicit `vfs` chain — that
   * chain is theirs to arrange.
   */
  bundleFromManifest?: boolean;
}

export interface WorkerApi {
  init(opts: WorkerInitOptions, host?: BackendHost & Comlink.ProxyMarked): Promise<void>;
  run(opts: RunOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

/**
 * The WASMFS (-sWASMFS=1) JS API is a *subset* of the legacy FS shim:
 * FS.isDir/isFile don't exist, and FS.analyzePath internally readFile()s any
 * existing path — which throws EISDIR for directories. Only the members
 * below are safe to use; existence/type checks go through stat() (see
 * pathExists / isDirMode).
 */
interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  chdir(path: string): void;
  unlink(path: string): void;
}

interface EmscriptenModule {
  FS: EmscriptenFS;
  ENV: Record<string, string>;
  callMain(args: string[]): number;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _texlive_setenv?: (key: number, value: number) => number;
  _udata_setCommonData_78?: (dataPtr: number, errPtr: number) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

type ModuleFactory = (
  opts?: Partial<EmscriptenModule> & Record<string, unknown>,
) => Promise<EmscriptenModule>;

/** Engines that speak web2c/kpathsea argv conventions (-fmt, -cnf-line). */
const TEX_ENGINES: ReadonlySet<EngineId> = new Set(['pdflatex', 'xelatex', 'lualatex']);

/** Minimal fontconfig config for XeTeX (see createInstance). */
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/texmf-dist/fonts/opentype</dir>
  <dir>/texmf-dist/fonts/truetype</dir>
  <dir>/texmf-dist/fonts/type1</dir>
  <cachedir>/tmp/fontcache</cachedir>
  <config>
    <rescan><int>0</int></rescan>
  </config>
</fontconfig>
`;

/**
 * Per-engine default `-fmt` path. Present once the TDS map has been
 * populated into MEMFS; consumers can override via RunOptions.env.
 */
const FMT_PATH: Partial<Record<EngineId, string>> = {
  pdflatex: '/texmf-dist/web2c/pdftex/pdflatex.fmt',
  xelatex: '/texmf-dist/web2c/xetex/xelatex.fmt',
  lualatex: '/texmf-dist/web2c/luatex/lualatex.fmt',
};

/** The diagnostic file each tool writes; xdvipdfmx has none (stderr only). */
const LOG_EXT: Partial<Record<EngineId, string>> = {
  pdflatex: '.log',
  xelatex: '.log',
  lualatex: '.log',
  bibtexu: '.blg',
  biber: '.blg',
  makeindex: '.ilg',
};

/** The argument each tool takes its job stem from. */
const INPUT_ARG_RE: Partial<Record<EngineId, RegExp>> = {
  pdflatex: /\.(tex|ltx)$/i,
  xelatex: /\.(tex|ltx)$/i,
  lualatex: /\.(tex|ltx)$/i,
  bibtexu: /\.aux$/i,
  biber: /\.bcf$/i,
  makeindex: /\.idx$/i,
  xdvipdfmx: /\.xdv$/i,
};

/** A caller that passes -fmt= or builds a format with -ini owns the choice. */
function selectsOwnFormat(args: string[]): boolean {
  return args.some((a) => /^--?(fmt|ini|initialize)\b/.test(a));
}

class WorkerImpl implements WorkerApi {
  private inputs = new InputBlobCache();
  private engineId: EngineId | null = null;
  private config: EngineConfig | null = null;
  private backends: VfsBackend[] = [];
  private glueFactory: ModuleFactory | null = null;
  /**
   * The wasm compiled ONCE per worker. Every run needs a fresh Emscripten
   * *instance* (engines aren't reentrant), but without this cache the glue
   * re-fetches and re-compiles the multi-MB binary each time — WKWebView
   * has no wasm code cache, so on iOS that's a full compile per run.
   * null → the glue manages its own loading (fallback).
   */
  private wasmModule: WebAssembly.Module | null = null;
  private icuData: Uint8Array | null = null;
  /** TDS-relative path → bytes; repopulated into every fresh instance. */
  private tdsFiles = new Map<string, Uint8Array>();
  /**
   * /tmp/texmf-var contents harvested after each run and re-seeded into the
   * next fresh instance — luaotfload's font-name database alone is worth
   * multi-second rebuilds otherwise. Worker-scoped, so it can never outlive
   * the TDS it was built from (a TDS change means a new worker + init()).
   */
  private varFiles = new Map<string, Uint8Array>();
  private fontFiles = new Map<string, Uint8Array>();
  private projectFonts = new Map<string, Uint8Array>();
  private treeSize = -1;
  private treePlan: { absolute: string; parent: string; path: string; encoded: Uint8Array }[] = [];
  private lsR = '';

  private prepareTree(): void {
    if (this.treeSize === this.tdsFiles.size) return;
    const encoder = new TextEncoder();
    this.treePlan = [...this.tdsFiles.keys()].map((path) => {
      const absolute = `/texmf-dist/${path}`;
      return {
        path,
        absolute,
        parent: dirname(absolute),
        encoded: encoder.encode(absolute + '\0'),
      };
    });
    this.lsR = buildLsR(this.tdsFiles.keys());
    this.treeSize = this.tdsFiles.size;
  }
  /**
   * basename → full TDS paths, built from the manifest (config.manifestUrl).
   * The lazy-fetch retry resolves log-reported names ("lmodern.sty") to
   * exact backend paths through this instead of guessing locations; the
   * guessing heuristic stays as fallback for unindexed names.
   */
  private nameIndex = new Map<string, string[]>();
  /** Whether the last created instance mounted the TDS lazily (see tryMountLazyTds). */
  private lazyMounted = false;
  /** The eager-fallback warning is worth saying once, not once per instance. */
  private eagerWarned = false;
  // Stable sinks bound at module-factory time. Emscripten's glue captures
  // print/printErr into internal out/err ONCE at instantiation — reassigning
  // module.print afterwards has no effect, so the closures must stay fixed
  // and write through mutable buffers instead.
  private stdoutBuf = '';
  private stderrBuf = '';

  async init(opts: WorkerInitOptions, host?: BackendHost): Promise<void> {
    this.inputs = new InputBlobCache(opts.config.projectCacheBytes);
    this.engineId = opts.engineId;
    this.config = opts.config;
    this.backends = (opts.backendMeta ?? []).map((meta, i) =>
      reconstructBackend(meta, i, host ?? null),
    );

    // Download/compile independent runtime assets while the TDS unpacks.
    const runtime = this.loadRuntime(opts).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );

    // The core bundle is fetched and unpacked here in the worker (highest
    // priority backend) — the browser HTTP cache dedupes the download
    // across engine instances and no file bytes cross the RPC boundary.
    const allowUnverified = opts.config.allowUnverifiedAssets === true;
    if (opts.config.bundleUrl) {
      this.backends.unshift(
        await createBundleFs({
          bundleUrl: opts.config.bundleUrl,
          ...(opts.config.bundleSha256 ? { sha256: opts.config.bundleSha256 } : {}),
          allowUnverified,
        }),
      );
    } else if (opts.bundleFromManifest && opts.config.manifestUrl) {
      this.backends.unshift(
        await createBundleFs({ manifestUrl: opts.config.manifestUrl, allowUnverified }),
      );
    }

    const packs = await Promise.all(
      (opts.config.resourcePacks ?? []).map((pack) => {
        if (!/^[a-f0-9]{64}$/i.test(pack.sha256))
          throw new Error('Resource packs require a SHA-256 digest');
        return createBundleFs({ bundleUrl: pack.url, sha256: pack.sha256 });
      }),
    );
    // Keep the core first; packs add resources without replacing its format/packages.
    const offset = opts.config.bundleUrl || opts.bundleFromManifest ? 1 : 0;
    this.backends.splice(offset, 0, ...packs);
    await Promise.all(this.backends.map((b) => b.init?.()));

    const runtimeResult = await runtime;
    if (runtimeResult.error) throw runtimeResult.error;

    // Drain every backend that exposes list() into the in-worker TDS map.
    for (const backend of this.backends) {
      if (!backend.list) continue;
      const paths = await backend.list('');
      for (let start = 0; start < paths.length; start += 64) {
        await Promise.all(
          paths.slice(start, start + 64).map(async (tdsPath) => {
            const rel = safeRelativePath(tdsPath);
            if (!rel || this.tdsFiles.has(rel)) return;
            const bytes = await backend.read(tdsPath);
            if (bytes && !this.tdsFiles.has(rel)) this.tdsFiles.set(rel, bytes);
          }),
        );
      }
    }

    // Optional precise-resolution index for the lazy-fetch retry. Failure is
    // non-fatal: the heuristic resolver still works, just less precisely.
    if (opts.config.manifestUrl) {
      try {
        const manifest = await loadManifest(opts.config.manifestUrl);
        for (const path of Object.keys(manifest.files)) {
          const name = path.slice(path.lastIndexOf('/') + 1);
          const existing = this.nameIndex.get(name);
          if (existing) existing.push(path);
          else this.nameIndex.set(name, [path]);
        }
      } catch {
        this.nameIndex.clear();
      }
    }
  }

  private async loadRuntime(opts: WorkerInitOptions): Promise<void> {
    await Promise.all([
      (async () => {
        if (opts.config.fmtPath) {
          const fmt = FMT_PATH[opts.engineId];
          if (!fmt) throw new Error(`Engine ${this.engineId} does not use a LaTeX format`);
          const response = await fetchAsset(opts.config.fmtPath);
          if (!response.ok) throw new Error(`HTTP ${response.status} fetching fmtPath`);
          this.tdsFiles.set(
            fmt.slice('/texmf-dist/'.length),
            new Uint8Array(await response.arrayBuffer()),
          );
        }
      })(),
      (async () => {
        const glueUrl = this.resolveEngineGlueUrl();
        this.glueFactory = (
          (await import(/* @vite-ignore */ glueUrl)) as { default: ModuleFactory }
        ).default;
      })(),
      (async () => {
        // Compile the wasm once up front (see wasmModule doc). Any failure —
        // exotic URL scheme, missing CORS, Node file:// — falls back to the
        // glue's own loader, which is correct just slower.
        if (opts.config.enginePath) {
          try {
            const r = await fetchAsset(opts.config.enginePath);
            if (r.ok) {
              this.wasmModule = await WebAssembly.compile(await r.arrayBuffer());
            }
          } catch {
            this.wasmModule = null;
          }
        }
      })(),
      (async () => {
        this.icuData = opts.icuData ?? null;
        if (!this.icuData && opts.config.icuDataUrl) {
          const r = await fetchAsset(opts.config.icuDataUrl);
          if (!r.ok) {
            throw new Error(
              `texlive-wasm: HTTP ${r.status} fetching icuDataUrl ${opts.config.icuDataUrl}`,
            );
          }
          this.icuData = new Uint8Array(await r.arrayBuffer());
        }
      })(),
    ]);
  }

  /** Build a fresh engine instance with the TDS + ICU state applied. */
  private async createInstance(stdin?: string | Uint8Array): Promise<EmscriptenModule> {
    if (!this.engineId || !this.glueFactory) {
      throw new Error('Worker.init() must be called before run()');
    }
    const input = stdin === undefined ? new Uint8Array() : normalizeBytes(stdin);
    let inputOffset = 0;
    const cachedModule = this.wasmModule;
    const module = await this.glueFactory({
      noInitialRun: true,
      stdin: () => input[inputOffset++] ?? null,
      thisProgram: `/bin/${this.engineId}`,
      print: (line: string) => {
        this.stdoutBuf += line + '\n';
      },
      printErr: (line: string) => {
        this.stderrBuf += line + '\n';
      },
      // Instantiate from the worker-cached Module instead of letting the
      // glue re-fetch + re-compile the binary for every fresh instance.
      ...(cachedModule
        ? {
            instantiateWasm: (
              imports: WebAssembly.Imports,
              done: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
            ) => {
              void WebAssembly.instantiate(cachedModule, imports).then((instance) =>
                done(instance, cachedModule),
              );
              return {}; // async instantiation — exports arrive via done()
            },
          }
        : {}),
    });

    if (this.icuData && module._udata_setCommonData_78) {
      const ptr = module._malloc(this.icuData.length);
      module.HEAPU8.set(this.icuData, ptr);
      const errPtr = module._malloc(4);
      module.HEAPU32[errPtr >> 2] = 0;
      module._udata_setCommonData_78(ptr, errPtr);
      const status = module.HEAPU32[errPtr >> 2]! | 0;
      module._free(errPtr);
      // ICU warnings are negative; positive statuses mean initialization failed.
      if (status > 0) throw new Error(`ICU data initialization failed (UErrorCode=${status})`);
    }

    const FS = module.FS;
    const dirs = new Set<string>(['/']);
    mkdirCached(FS, '/bin', dirs);
    FS.writeFile(`/bin/${this.engineId}`, new Uint8Array());
    mkdirCached(FS, '/project', dirs);
    // XeTeX resolves by-name font requests through fontconfig, which hard-
    // fails at startup without a config file ("cannot read font names").
    // Point it at the TDS font trees; both paths are probed by our build
    // (/etc/fonts and the --prefix=/usr/local default).
    if (this.engineId === 'xelatex') {
      mkdirCached(FS, '/etc/fonts', dirs);
      mkdirCached(FS, '/usr/local/etc/fonts', dirs);
      mkdirCached(FS, '/tmp/fontcache', dirs);
      FS.writeFile('/etc/fonts/fonts.conf', FONTS_CONF);
      FS.writeFile('/usr/local/etc/fonts/fonts.conf', FONTS_CONF);
    }
    if (!pathExists(FS, '/tmp')) FS.mkdir('/tmp');
    dirs.add('/tmp');
    // Writable cache root for luaotfload and friends (see TEXMFVAR/
    // TEXMFCACHE -cnf-line args in run()); re-seed the caches harvested
    // from previous runs so they don't get rebuilt from scratch.
    mkdirCached(FS, '/tmp/texmf-var', dirs);
    for (const [rel, bytes] of this.varFiles) {
      const absolute = `/tmp/texmf-var/${rel}`;
      mkdirCached(FS, dirname(absolute), dirs);
      FS.writeFile(absolute, bytes);
    }

    for (const [rel, bytes] of this.fontFiles) {
      const absolute = `/tmp/fontcache/${rel}`;
      mkdirCached(FS, dirname(absolute), dirs);
      FS.writeFile(absolute, bytes);
    }
    this.prepareTree();

    // biber's VFS (biber-vfs.tar.gz: perl/ + biber/ trees) mounts at the
    // filesystem ROOT — it is a Perl runtime, not a texmf tree. Everything
    // else is TDS-relative under /texmf-dist.
    //
    // TDS materialization has two paths:
    //  - LAZY (preferred): engines built with the wasmfs-lazy backend keep
    //    the file BYTES on the JS side; only cheap file nodes are created
    //    and data is copied into the heap read-by-read. Saves ~250 MB of
    //    heap per instance and nearly all of the per-run setup time.
    //  - EAGER (permanent fallback): write every file into MEMFS — older
    //    artifacts, biber, or any lazy-mount failure land here.
    //
    // The lazy mount MUST be attempted before anything creates /texmf-dist:
    // wasmfs_create_directory is mkdir-like, so mounting onto an existing
    // directory fails with EEXIST and silently drops us into the eager path.
    this.lazyMounted = this.engineId === 'biber' ? false : this.tryMountLazyTds(module, dirs);
    if (!this.lazyMounted) {
      const fsRoot = this.engineId === 'biber' ? '' : '/texmf-dist';
      if (fsRoot) mkdirCached(FS, fsRoot, dirs);
      for (const [tdsPath, bytes] of this.tdsFiles) {
        const absolute = `${fsRoot}/${tdsPath}`;
        mkdirCached(FS, dirname(absolute), dirs);
        FS.writeFile(absolute, bytes);
      }
    }
    if (this.engineId !== 'biber') {
      // Regenerate the kpathsea filename database from what is ACTUALLY in
      // the map — any bundled ls-R is stale the moment the lazy-fetch retry
      // adds a file, and with $TEXMFDBS set the db is authoritative. Keeping
      // it exact turns every `//` search into an O(1) db hit. (Under the
      // lazy mount the write lands in the handler's copy-on-write map.)
      FS.writeFile('/texmf-dist/ls-R', this.lsR);
    }
    return module;
  }

  /**
   * Mount /texmf-dist as a lazy WASMFS JSImpl tree (engine/scripts/
   * wasmfs-lazy.c). Returns false when the artifact lacks the backend or
   * anything goes wrong — the caller then materializes eagerly.
   *
   * Every failure path is announced: the eager fallback still produces the
   * right PDF, so a silent degradation is invisible until an engine instance
   * has copied a quarter of a gigabyte into the heap and the WebView dies.
   */
  private tryMountLazyTds(module: EmscriptenModule, dirs: Set<string>): boolean {
    if (this.config?.lazyTds === false) return false;
    const m = module as EmscriptenModule & {
      _texlive_mount_lazy?: () => number;
      _texlive_touch?: (pathPtr: number) => number;
      stringToUTF8?: (str: string, ptr: number, max: number) => void;
      texliveLazyBackend?: unknown;
    };
    if (!m._texlive_mount_lazy || !m._texlive_touch || !m.stringToUTF8) {
      this.warnEagerFallback(
        'the engine artifact does not export the lazy WASMFS backend (rebuild it)',
      );
      return false;
    }
    try {
      // Per-instance handler: file id → bytes (tar-backed views for touched
      // nodes, copy-on-write for anything the engine writes, e.g. ls-R).
      const fileBytes = new Map<number, Uint8Array>();
      let pending: Uint8Array | null = null;
      m.texliveLazyBackend = {
        allocFile: (file: number) => {
          if (pending) {
            fileBytes.set(file, pending);
            pending = null;
          }
        },
        freeFile: (file: number) => {
          fileBytes.delete(file);
        },
        getSize: (file: number) => fileBytes.get(file)?.length ?? 0,
        read: (file: number, buffer: number, length: number, offset: number) => {
          const bytes = fileBytes.get(file);
          if (!bytes || offset >= bytes.length) return 0;
          const n = Math.min(length, bytes.length - offset);
          module.HEAPU8.set(bytes.subarray(offset, offset + n), buffer);
          return n;
        },
        write: (file: number, buffer: number, length: number, offset: number) => {
          const prev = fileBytes.get(file) ?? new Uint8Array(0);
          let next: Uint8Array;
          if (prev.length >= offset + length) {
            next = prev.slice();
          } else {
            next = new Uint8Array(offset + length);
            next.set(prev);
          }
          next.set(module.HEAPU8.subarray(buffer, buffer + length), offset);
          fileBytes.set(file, next);
          return length;
        },
        setSize: (file: number, size: number) => {
          const prev = fileBytes.get(file) ?? new Uint8Array(0);
          const next = new Uint8Array(size);
          next.set(prev.subarray(0, Math.min(size, prev.length)));
          fileBytes.set(file, next);
          return 0;
        },
      };
      const mountRc = m._texlive_mount_lazy();
      if (mountRc !== 0) {
        // -EEXIST here means something created /texmf-dist before the mount.
        this.warnEagerFallback(`texlive_mount_lazy() failed with ${mountRc}`);
        return false;
      }
      dirs.add('/texmf-dist');
      const scratch = module._malloc(4096);
      let failedTouch: string | null = null;
      try {
        for (const { path, absolute, parent, encoded } of this.treePlan) {
          if (encoded.length > 4096) throw new Error('TDS path exceeds 4095 bytes');
          mkdirCached(module.FS, parent, dirs);
          pending = this.tdsFiles.get(path)!;
          module.HEAPU8.set(encoded, scratch);
          const rc = m._texlive_touch(scratch);
          pending = null; // a failed touch must not leak onto the next node
          if (rc !== 0) {
            // One unreachable file would surface much later as a mysterious
            // "I can't find file" — fail the mount instead and materialize
            // the tree the slow way, which cannot miss a file.
            failedTouch = `${absolute} (rc=${rc})`;
            break;
          }
        }
      } finally {
        module._free(scratch);
      }
      if (failedTouch) {
        this.warnEagerFallback(`texlive_touch() failed for ${failedTouch}`);
        return false;
      }
      return true;
    } catch (err) {
      this.warnEagerFallback(`lazy mount threw (${String(err)})`);
      return false;
    }
  }

  /** Once per worker: a compile builds several instances, all with the same verdict. */
  private warnEagerFallback(reason: string): void {
    if (this.eagerWarned) return;
    this.eagerWarned = true;
    console.warn(
      `texlive-wasm: ${this.engineId} is materializing the TeX tree eagerly because ` +
        `${reason}. Every engine instance now copies the whole tree into the wasm heap; ` +
        `on a mobile WebView that is a likely out-of-memory.`,
    );
  }

  async run(opts: RunOptions): Promise<RunResult> {
    if (!this.engineId || !this.config || !this.glueFactory) {
      throw new Error('Worker.init() must be called before run()');
    }
    const startedAt = performance.now();

    // On-miss lazy fetch: a hard "I can't find file X" fails the compile;
    // we parse those out of the .log, pull the files from the backends into
    // the TDS map, and re-run — on a fresh instance, like every run. One
    // retry resolves everything a nonstopmode pass reported; raise
    // maxRetries when packages pull in further missing files transitively
    // (cheap with local backends like TauriFS).
    const lazy = opts.lazyFetch ?? true;
    const maxRetries = lazy === false ? 0 : lazy === true ? 8 : Math.max(0, lazy.maxRetries ?? 8);
    let exitCode = 0;
    let retriesUsed = 0;
    let inputTransport: { sentBytes: number; reusedBytes: number } | undefined = opts.files
      ? {
          sentBytes: opts.files.reduce((sum, file) => sum + normalizeBytes(file.content).length, 0),
          reusedBytes: 0,
        }
      : undefined;
    if (opts.fileRefs) {
      const received = await this.inputs.receive(opts.fileRefs, opts.fileBlobs ?? []);
      opts = { ...opts, files: received.files };
      inputTransport = { sentBytes: received.sentBytes, reusedBytes: received.reusedBytes };
    }
    const missingAttempts = new Set<string>();
    const projectFonts = new Map(
      (opts.files ?? [])
        .filter((file) => /\.(otf|ttf|ttc|pfb|pfa|tfm|vf|enc|map)$/i.test(file.path))
        .map((file) => [file.path, normalizeBytes(file.content)]),
    );
    if (
      projectFonts.size !== this.projectFonts.size ||
      [...projectFonts].some(([path, bytes]) => {
        const previous = this.projectFonts.get(path);
        return !previous || !sameBytes(previous, bytes);
      })
    ) {
      this.varFiles.clear();
      this.fontFiles.clear();
    }
    this.projectFonts = projectFonts;

    let stdout = '';
    let stderr = '';
    let outputs = new Map<string, Uint8Array>();
    let log = '';

    // What we wrote into /project, so the run can hand back only what the
    // engine actually produced (see collectProduced).
    const inputs = new Map<string, Uint8Array>();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let module: EmscriptenModule;
      let FS: EmscriptenFS;
      try {
        module = await this.createInstance(opts.stdin);
        FS = module.FS;
        for (const [key, value] of Object.entries(opts.processEnv ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0'))
            throw new Error('Invalid process environment variable');
          if (!module._texlive_setenv)
            throw new Error('processEnv requires an engine built with texlive_setenv (v0.4+)');
          const encoder = new TextEncoder();
          const k = encoder.encode(key + '\0'),
            v = encoder.encode(value + '\0');
          const kp = module._malloc(k.length),
            vp = module._malloc(v.length);
          try {
            module.HEAPU8.set(k, kp);
            module.HEAPU8.set(v, vp);
            if (module._texlive_setenv(kp, vp) !== 0)
              throw new Error(`Unable to set process variable ${key}`);
          } finally {
            module._free(kp);
            module._free(vp);
          }
        }
        inputs.clear();
        for (const file of opts.files ?? []) {
          const rel = safeRelativePath(file.path);
          if (!rel) {
            throw new Error(
              `texlive-wasm: refusing file input with an escaping path: ${file.path}`,
            );
          }
          const bytes = normalizeBytes(file.content);
          const absolute = `/project/${rel}`;
          mkdirP(FS, dirname(absolute));
          FS.writeFile(absolute, bytes);
          inputs.set(rel, bytes);
        }
      } catch (err) {
        rethrowIfOom(err);
        throw err;
      }
      // The engine reads and writes relative to the cwd, so an unconfined one
      // is a write primitive anywhere in the tree.
      const cwd = safeResolve('/project', opts.cwd ?? '/project');
      if (!cwd) {
        throw new Error(`texlive-wasm: refusing a cwd outside /project: ${opts.cwd}`);
      }
      FS.chdir(cwd);

      const argv = [...this.standardArgs(FS, opts), ...opts.args];

      this.stdoutBuf = '';
      this.stderrBuf = '';
      try {
        exitCode = module.callMain(argv);
      } catch (err) {
        const e = err as { status?: number };
        if (typeof e?.status === 'number') {
          exitCode = e.status;
        } else {
          rethrowIfOom(err);
          throw err;
        }
      }
      stdout += this.stdoutBuf;
      stderr += this.stderrBuf;

      outputs = new Map<string, Uint8Array>();
      collectProduced(FS, '/project', '', inputs, outputs);
      log = this.findLog(FS, opts.args, cwd);

      // Harvest engine-written caches (luaotfload font db, etc.) for the
      // next instance — even failed compiles usually completed the cache
      // build, so harvest unconditionally.
      if (this.config?.persistTexmfVar !== false) {
        try {
          this.varFiles.clear();
          collectFiles(FS, '/tmp/texmf-var', '', this.varFiles);
          if (this.engineId === 'xelatex') {
            this.fontFiles.clear();
            collectFiles(FS, '/tmp/fontcache', '', this.fontFiles);
          }
        } catch {
          // A run that never touched the cache dir is fine.
        }
      }

      if (exitCode === 0 || attempt === maxRetries) break;

      // xdvipdfmx writes no log file — its complaints only exist on stderr.
      const missing = parseMissingFiles(log || `${this.stdoutBuf}\n${this.stderrBuf}`);
      if (missing.length === 0) break;
      const fetched = await this.fetchMissingIntoTds(missing, missingAttempts);
      if (fetched === 0) break;
      retriesUsed++;
    }

    const result: RunResult = {
      inputCache: this.inputs.keys(),
      ...(inputTransport ? { inputTransport } : {}),
      exitCode,
      stdout,
      stderr,
      outputs,
      log,
      durationMs: performance.now() - startedAt,
      lazyFetchRetries: retriesUsed,
      lazyTds: this.lazyMounted,
    };
    // Hand the output buffers over instead of structured-cloning them: the
    // PDF (and any generated image) is otherwise copied once more on its way
    // out of the worker. Only whole-buffer views are transferable — detaching
    // a buffer we only partly own would take the rest of it with us.
    const transferables = new Set<ArrayBuffer>();
    for (const bytes of outputs.values()) {
      const buffer = bytes.buffer;
      if (
        buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === buffer.byteLength
      ) {
        transferables.add(buffer);
      }
    }
    return Comlink.transfer(result, [...transferables]);
  }

  /** -fmt/-cnf-line are web2c TeX-engine conventions; the other engines reject them. */
  private standardArgs(FS: EmscriptenFS, opts: RunOptions): string[] {
    if (!this.engineId || !TEX_ENGINES.has(this.engineId)) return [];
    const args: string[] = [];
    const fmt = FMT_PATH[this.engineId];
    if (fmt && pathExists(FS, fmt) && !selectsOwnFormat(opts.args)) {
      args.push(`-fmt=${fmt}`);
    } else if (!selectsOwnFormat(opts.args)) {
      // Without a format the engine falls back to mktexfmt, which needs
      // fork(2) — ENOSYS in wasm. That surfaces as an unreadable crash deep
      // in kpathsea, so say what is actually missing instead.
      throw new Error(
        `texlive-wasm: no LaTeX format for ${this.engineId} — ${fmt} is not in the TeX tree. ` +
          `Install the engine's core bundle ('npx @typeward/texlive-wasm download-assets') and point ` +
          `config.bundleUrl or config.manifestUrl at it, or pass your own -fmt=/-ini argument.`,
      );
    }
    args.push(
      '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
      '-cnf-line=TEXMF=/texmf-dist',
      '-cnf-line=TEXMFDIST=/texmf-dist',
      // Writable cache — luaotfload refuses to start without one. Both vars
      // must point at the SAME root: with openout_any=p (paranoid, the TL
      // default) LuaTeX only permits absolute-path writes under $TEXMFVAR /
      // $TEXMFSYSVAR, and luaotfload prefers $TEXMFCACHE — pointing it
      // anywhere else gets every cache mkdir/write "operation not
      // permitted" (verified against the real engine).
      '-cnf-line=TEXMFVAR=/tmp/texmf-var',
      '-cnf-line=TEXMFCACHE=/tmp/texmf-var',
      // The ls-R we regenerate per instance is exact, so db lookups are
      // authoritative and every recursive `//` search below becomes a hash
      // hit instead of a MEMFS directory walk.
      '-cnf-line=TEXMFDBS=/texmf-dist',
      '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
      '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
      '-cnf-line=VFFONTS=/texmf-dist/fonts/vf//',
      '-cnf-line=T1FONTS=/texmf-dist/fonts/type1//',
      '-cnf-line=ENCFONTS=/texmf-dist/fonts/enc//',
      '-cnf-line=TEXFONTMAPS=/texmf-dist/fonts/map//',
      '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//;/texmf-dist/fonts/truetype//;/texmf-dist/fonts/type1//',
      '-cnf-line=TRUETYPEFONTS=/texmf-dist/fonts/truetype//',
    );
    // RunOptions.env entries become texmf.cnf overrides — the only runtime
    // environment channel Emscripten leaves us (ENV is frozen after init).
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push(`-cnf-line=${key}=${value}`);
    }
    return args;
  }

  /**
   * For each missing TDS path the log complained about, walk the backend
   * chain and store the bytes into the TDS map (the next instance picks
   * them up). Returns how many files were resolved. Searches multiple
   * plausible TDS sublocations because the log usually says
   * "lmroman10-regular.otf", not the absolute TDS path.
   */
  private async fetchMissingIntoTds(
    missing: string[],
    attempted = new Set<string>(),
  ): Promise<number> {
    let written = 0;
    for (const name of new Set(missing)) {
      for (const backend of this.backends) {
        if (!backend.resolve) continue;
        const key = `resolve:${backend.id}:${name}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        const resolved = await backend.resolve(name);
        for (const file of resolved) {
          const path = safeRelativePath(file.path);
          if (!path || this.tdsFiles.has(path)) continue;
          this.tdsFiles.set(path, file.content);
          written++;
          if (path.startsWith('fonts/')) {
            this.varFiles.clear();
            this.fontFiles.clear();
          }
        }
        if (resolved.some((file) => file.path.split('/').pop() === name.split('/').pop())) break;
      }
      // Exact manifest paths first; heuristic location guessing as fallback.
      const indexed = name.includes('/') ? [] : (this.nameIndex.get(name) ?? []);
      // These names were parsed out of an engine log — i.e. out of whatever
      // the document asked TeX to \input. Nothing downstream of here may see
      // a path that leaves /texmf-dist.
      const candidates = [...indexed, ...expandMissingName(name)]
        .map((c) => safeRelativePath(c))
        .filter((c): c is string => c !== null);
      for (const candidate of candidates) {
        if (this.tdsFiles.has(candidate) || attempted.has(candidate)) continue;
        attempted.add(candidate);
        let bytes: Uint8Array | null = null;
        for (const backend of this.backends) {
          try {
            const r = await backend.read(candidate);
            if (r) {
              bytes = r;
              break;
            }
          } catch {
            // A flaky backend (offline CDN, 5xx) must not abort the whole
            // retry — fall through to the next backend.
          }
        }
        if (bytes) {
          this.tdsFiles.set(candidate, bytes);
          if (candidate.startsWith('fonts/')) {
            this.varFiles.clear();
            this.fontFiles.clear();
          }
          written++;
          break;
        }
      }
    }
    return written;
  }

  /**
   * Locate the diagnostic file this engine writes. TeX engines write
   * `<jobname>.log`; the helpers each have their own (bibtexu/biber `.blg`,
   * makeindex `.ilg`) and none of them accepts a `-jobname`, so their names
   * derive from the file they were pointed at. Without this, the on-miss
   * lazy fetch below is a no-op for every helper — it never even finds a log
   * to read. xdvipdfmx writes no log at all; its diagnostics are on stderr.
   */
  private findLog(FS: EmscriptenFS, args: string[], cwd: string): string {
    if (!this.engineId) return '';
    if (this.engineId === 'makeindex') {
      const index = args.indexOf('-t');
      if (index >= 0 && args[index + 1]) {
        const path = safeResolve('/project', `${cwd}/${args[index + 1]}`);
        return path ? readTextFile(FS, path) : '';
      }
    }
    const ext = LOG_EXT[this.engineId];
    if (!ext) return ''; // xdvipdfmx: diagnostics go to stderr, not a file
    const stem = this.jobStem(args);
    if (!stem) return '';
    // The tool writes its log into the cwd under the job stem, regardless of
    // where the input file lived.
    const path = safeResolve('/project', `${cwd}/${stem}${ext}`);
    return path ? readTextFile(FS, path) : '';
  }

  /** Job stem: honors -jobname, else the basename of the tool's input file. */
  private jobStem(args: string[]): string | undefined {
    const jobArg = args.find((a) => /^--?jobname=/.test(a));
    if (jobArg) return jobArg.split('=')[1];
    const inputRe = INPUT_ARG_RE[this.engineId ?? 'pdflatex'] ?? /\.(tex|ltx)$/i;
    const candidates = args.filter((a) => !a.startsWith('-'));
    // biber is handed a bare jobname ("main"), not a file, so fall back to
    // the last positional argument when nothing matches the input pattern.
    const match = candidates.find((a) => inputRe.test(a)) ?? candidates[candidates.length - 1];
    return match?.replace(inputRe, '').split('/').pop();
  }

  async dispose(): Promise<void> {
    for (const b of this.backends) {
      await b.dispose?.();
    }
    this.glueFactory = null;
    this.wasmModule = null;
    this.tdsFiles.clear();
    this.varFiles.clear();
    this.fontFiles.clear();
    this.projectFonts.clear();
    this.inputs.clear();
    this.treePlan = [];
    this.treeSize = -1;
    this.lsR = '';
  }

  private resolveEngineGlueUrl(): string {
    if (!this.config || !this.engineId) {
      throw new Error('resolveEngineGlueUrl: config missing');
    }
    if (this.config.enginePath) {
      return this.config.enginePath.replace(/\.wasm(?=[?#]|$)/, '.js');
    }
    // No artifact ships inside the npm package (the .wasm files live on
    // GitHub Releases), so there is no meaningful default URL to guess —
    // and a bundler-mangled relative URL would 404 confusingly anyway.
    throw new Error(
      `texlive-wasm: config.enginePath is required. Download the engine artifacts ` +
        `('npx @typeward/texlive-wasm download-assets') and pass e.g. ` +
        `enginePath: '/texlive-wasm/${this.engineId}/emscripten/${this.engineId}.wasm'.`,
    );
  }
}

// ----- helpers --------------------------------------------------------------

function reconstructBackend(
  meta: BackendMeta,
  index: number,
  host: BackendHost | null,
): VfsBackend {
  if (!host) {
    throw new Error('Worker.init(): backendMeta supplied without a BackendHost proxy');
  }
  const backend: VfsBackend = {
    id: meta.id,
    read: (tdsPath: string) => host.read(index, tdsPath),
    exists: (tdsPath: string) => host.exists(index, tdsPath),
  };
  if (meta.hasResolve && host.resolve) backend.resolve = (name) => host.resolve!(index, name);
  if (meta.hasList) backend.list = (tdsPrefix: string) => host.list(index, tdsPrefix);
  if (meta.hasInit) backend.init = () => host.init(index);
  if (meta.hasDispose) backend.dispose = () => host.dispose(index);
  return backend;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/**
 * Emscripten reports heap-growth failure as an abort ("Cannot enlarge memory
 * arrays", "OOM") or a bare RangeError from WebAssembly.Memory.grow. Rethrow
 * those under a stable name (Comlink preserves name/message across the worker
 * boundary) so apps can react — dispose idle engines, retry — instead of
 * treating it as an opaque engine crash.
 */
function rethrowIfOom(err: unknown): void {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof RangeError || /cannot enlarge memory|out of memory|\bOOM\b/i.test(text)) {
    const oom = new Error(
      `engine ran out of memory (${text}); dispose idle engines or reduce concurrent workers, then retry`,
    );
    oom.name = 'EngineOutOfMemoryError';
    throw oom;
  }
}

/** Existence check that is safe for directories under WASMFS (see interface note). */
function pathExists(FS: EmscriptenFS, path: string): boolean {
  try {
    FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** S_IFDIR test on a stat mode — the WASMFS shim has no FS.isDir. */
function isDirMode(mode: number): boolean {
  return (mode & 0xf000) === 0x4000;
}

function mkdirP(FS: EmscriptenFS, path: string): void {
  if (!path || path === '/' || pathExists(FS, path)) return;
  mkdirP(FS, dirname(path));
  FS.mkdir(path);
}

/**
 * mkdir -p with a caller-held cache of created dirs — populating tens of
 * thousands of TDS files per instance makes per-file stat() checks add up.
 */
function mkdirCached(FS: EmscriptenFS, path: string, seen: Set<string>): void {
  if (!path || seen.has(path)) return;
  const parent = dirname(path);
  if (parent !== path) mkdirCached(FS, parent, seen);
  if (!pathExists(FS, path)) FS.mkdir(path);
  seen.add(path);
}

function normalizeBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function collectFiles(
  FS: EmscriptenFS,
  absDir: string,
  relPrefix: string,
  out: Map<string, Uint8Array>,
): void {
  for (const name of FS.readdir(absDir)) {
    if (name === '.' || name === '..') continue;
    const abs = `${absDir}/${name}`;
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const st = FS.stat(abs);
    if (isDirMode(st.mode)) {
      collectFiles(FS, abs, rel, out);
    } else {
      out.set(rel, FS.readFile(abs));
    }
  }
}

/**
 * Like collectFiles, but skips files that are byte-for-byte the input we
 * wrote — echoing a project's images and fonts back across the worker
 * boundary on every pass is the single biggest avoidable copy in a compile.
 * The size check keeps the common case (a big unchanged asset) from being
 * read out of the FS at all.
 */
function collectProduced(
  FS: EmscriptenFS,
  absDir: string,
  relPrefix: string,
  inputs: Map<string, Uint8Array>,
  out: Map<string, Uint8Array>,
): void {
  for (const name of FS.readdir(absDir)) {
    if (name === '.' || name === '..') continue;
    const abs = `${absDir}/${name}`;
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const st = FS.stat(abs);
    if (isDirMode(st.mode)) {
      collectProduced(FS, abs, rel, inputs, out);
      continue;
    }
    const input = inputs.get(rel);
    if (input && input.length === st.size) {
      const current = FS.readFile(abs);
      if (sameBytes(input, current)) continue;
      out.set(rel, current);
      continue;
    }
    out.set(rel, FS.readFile(abs));
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pull "I can't find file `x.sty'" / "Font ... not found" / "! LaTeX
 * Error: File `x.sty' not found" lines out of the .log and return the
 * referenced filenames.
 *
 * The helper tools each complain in their own dialect — bibtexu wants a
 * .bst, makeindex an .ist, xdvipdfmx a CMap or a font map — and they write
 * those complaints into their own log (.blg/.ilg, see WorkerImpl.findLog),
 * so their patterns live here too.
 */
function parseMissingFiles(log: string): string[] {
  if (!log) return [];
  const out = new Set<string>();
  const patterns = [
    // TeX engines.
    /I can't find file `([^']+)'/g,
    /File `([^']+)' not found/g,
    /language definition file\s+([\w.-]+\.ldf)/g,
    /file `([^']+)' is not loadable/g,
    /Cannot find ([\w.-]+\.(?:sty|cls|fd|def|cfg|tfm|vf|pfb|otf|ttf|mf|enc|map))/gi,
    // bibtex/bibtexu (.blg): "I couldn't open style file plainnat.bst".
    /I couldn't open (?:style|database|auxiliary) file ([\w./-]+)/g,
    // makeindex (.ilg): "Index style file custom.ist not found".
    /[Ii]ndex style file ([\w./-]+) not found/g,
    /Couldn't (?:open|find) (?:style|input) file ([\w./-]+)/g,
    // xdvipdfmx / dvipdfmx (stderr): missing CMaps, font maps, encodings.
    /Could not open (?:file|font|CMap)[:\s]+"?([\w./-]+)"?/g,
    /Unable to find (?:file|font)[:\s]+"?([\w./-]+)"?/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(log)) !== null) {
      const name = m[1]?.trim();
      if (name && !name.includes('//') && !name.startsWith('-')) out.add(name);
    }
  }
  return Array.from(out);
}

/**
 * Given a bare file name like "amsmath.sty", produce the candidate TDS
 * subpaths a backend might serve it under. The backend's read() will be
 * tried for each in order.
 */
function expandMissingName(name: string): string[] {
  if (name.startsWith('/')) return [name];
  if (name.includes('/')) return [name];
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const stem = name;
  const out = [stem];
  if (
    ext === 'sty' ||
    ext === 'ldf' ||
    ext === 'cls' ||
    ext === 'def' ||
    ext === 'fd' ||
    ext === 'cfg'
  ) {
    out.push(`tex/latex/${stem.replace(/\.\w+$/, '')}/${stem}`);
    out.push(`tex/latex/base/${stem}`);
    if (ext === 'ldf') {
      const language = /^(brazil|portugu)/.test(stem) ? 'portuges' : stem.replace(/\.ldf$/, '');
      out.push(`tex/generic/babel-${language}/${stem}`);
    }
  } else if (ext === 'tex' || ext === 'ltx') {
    out.push(`tex/generic/${stem.replace(/\.\w+$/, '')}/${stem}`);
  } else if (ext === 'tfm') {
    out.push(`fonts/tfm/public/${stem.replace(/\.\w+$/, '')}/${stem}`);
  } else if (ext === 'otf' || ext === 'ttf') {
    out.push(`fonts/opentype/public/${stem.replace(/\d.*$/, '')}/${stem}`);
    out.push(`fonts/truetype/public/${stem.replace(/\d.*$/, '')}/${stem}`);
  } else if (ext === 'pfb' || ext === 'pfa') {
    out.push(`fonts/type1/public/${stem.replace(/\d.*$/, '')}/${stem}`);
  } else if (ext === 'map' || ext === 'enc') {
    out.push(`fonts/${ext}/dvips/${stem.replace(/\.\w+$/, '')}/${stem}`);
  } else if (ext === 'bst') {
    // bibtexu's styles: TDS puts them under bibtex/bst/<package>/.
    out.push(`bibtex/bst/${stem.replace(/\.\w+$/, '')}/${stem}`);
    out.push(`bibtex/bst/base/${stem}`);
  } else if (ext === 'bib') {
    out.push(`bibtex/bib/${stem.replace(/\.\w+$/, '')}/${stem}`);
  } else if (ext === 'ist' || ext === 'mst') {
    out.push(`makeindex/${stem.replace(/\.\w+$/, '')}/${stem}`);
    out.push(`makeindex/base/${stem}`);
  } else if (ext === '' || ext === 'cmap') {
    // xdvipdfmx CMaps have no extension ("UniJIS-UCS2-H").
    out.push(`fonts/cmap/${stem}`);
  }
  return out;
}

function readTextFile(FS: EmscriptenFS, path: string): string {
  if (!pathExists(FS, path)) return '';
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(FS.readFile(path));
  } catch {
    return '';
  }
}

const api = new WorkerImpl();
// Only bind Comlink when we really are the worker. Importing this module from
// anywhere else (a test that drives the FS orchestration against a fake
// Emscripten module, an SSR pass) must not attach handlers to a foreign
// global — a Worker global has postMessage, Node does not.
if (typeof (globalThis as { postMessage?: unknown }).postMessage === 'function') {
  Comlink.expose(api);
}

export { WorkerImpl };
