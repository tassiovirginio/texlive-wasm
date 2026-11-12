/**
 * latexmk-style driver — multi-pass orchestration.
 *
 * Re-implements the small subset of latexmk's logic we actually need:
 *   1. Run the TeX engine.
 *   2. If `bibtex: 'auto'` and the document contains classic
 *      `\bibliography{…}` — or uses biblatex with `backend=bibtex` — run
 *      bibtexu against the .aux (with biblatex's required `--wolfgang`
 *      capacity mode in the latter case). biblatex documents on the
 *      default biber backend are left alone until biber.wasm ships.
 *   3. If `makeindex: 'auto'` and an .idx was produced (or changed), run
 *      makeindex.
 *   4. Re-run the TeX engine until `.aux` stabilizes (max 4 passes) and no
 *      "Rerun to get cross-references right" message appears in the log.
 *   5. For xelatex, run xdvipdfmx on the resulting .xdv.
 *   6. Collect outputs (.pdf, .synctex.gz, .log).
 *
 * Each engine runs in its own worker with an isolated filesystem that is
 * wiped on every run, so the accumulated project state (sources + generated
 * .aux/.bbl/.idx/.ind/.xdv) is re-materialized into every invocation.
 *
 * Single source of truth for the compile pipeline. Engine wrappers (PdfLatex,
 * XeLatex, LuaLatex) handle individual invocations.
 */

import type {
  CompileResult,
  EngineConfig,
  EngineHandle,
  EngineId,
  FileInput,
  LogEntry,
  RunResult,
} from '../core/types';
import type { RunLimits } from '../engines/base';
import { PdfLatex } from '../engines/pdflatex';
import { XeLatex } from '../engines/xelatex';
import { LuaLatex } from '../engines/lualatex';
import { Bibtexu } from '../engines/bibtexu';
import { Biber } from '../engines/biber';
import { Makeindex } from '../engines/makeindex';
import { Xdvipdfmx } from '../engines/xdvipdfmx';

export type LatexmkEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface LatexmkOptions {
  engine: LatexmkEngine;
  mainTex: string;
  files: FileInput[];
  /**
   * How to build the engines this driver needs. Every engine is a separate
   * wasm artifact, so at minimum each needs its `enginePath`; pass one config
   * for all of them, or a factory to vary it per engine:
   *
   *     engineConfig: (id) => ({ enginePath: `/texlive-wasm/${id}.wasm`, bundleUrl })
   *
   * Engines supplied via `handles` are used as-is and ignore this.
   */
  engineConfig?: EngineConfig | ((id: EngineId) => EngineConfig);
  /** 'auto' (default) inspects the source; true forces; false skips. */
  bibtex?: boolean | 'auto';
  /**
   * biber for default-backend biblatex documents. 'auto' (default) runs it
   * when the sources load biblatex without `backend=bibtex`. Requires a
   * biber engine handle (or enginePath config) — the artifact is optional
   * and larger than the others (~10 MB + its VFS bundle).
   */
  biber?: boolean | 'auto';
  makeindex?: boolean | 'auto';
  /**
   * Re-run for cross-refs/TOC. 'auto' (default) stops when .aux stabilizes;
   * false forces a single pass; { maxPasses } caps the loop.
   */
  rerun?: boolean | 'auto' | { maxPasses: number };
  /** Pass -synctex=1 so the engine emits a .synctex.gz. Default: false. */
  synctex?: boolean;
  /**
   * Deadline for the WHOLE pipeline, in ms — every pass and every helper
   * shares it, so a document that loops forever cannot outlive it by running
   * one more pass. Default: none (each individual invocation still carries
   * the wrapper default, see engines/base DEFAULT_RUN_TIMEOUT_MS).
   * Enforcing it terminates the engine worker.
   */
  timeoutMs?: number;
  /** Cancels the pipeline — same worker-terminating semantics as `timeoutMs`. */
  signal?: AbortSignal;
  /** Verbosity forwarded to engines this driver creates. */
  verbose?: 'silent' | 'info' | 'debug';
  /**
   * Engines to reuse instead of letting this driver build them from
   * `engineConfig` — e.g. handles kept alive by an EngineManager.
   */
  handles?: {
    tex?: EngineHandle;
    bibtex?: EngineHandle;
    biber?: EngineHandle;
    makeindex?: EngineHandle;
    xdvipdfmx?: EngineHandle;
  };
}

export interface LatexmkResult extends CompileResult {
  /** Number of TeX engine passes actually run. */
  passes: number;
  /** Whether auxiliary files stabilized without a rerun request. */
  converged: boolean;
  /** The pass cap prevented the requested convergence. */
  maxPassesReached: boolean;
}

const RERUN_PATTERNS = [
  /Rerun to get cross-references right/,
  /Rerun to get citations correct/,
  /Label\(s\) may have changed/,
  /No file [^.]+\.toc/,
  /Package rerunfilecheck Warning/,
  // biblatex's generic rerun request (it settles labels/backrefs late).
  /Please rerun LaTeX/,
  /Please \(re\)run Biber/,
];

const DEFAULT_MAX_PASSES = 4;
// biblatex needs an extra settling pass: tex → bibtex → tex → tex is the
// common case, and backref/label passes can add one more.
const BIBLATEX_MAX_PASSES = 5;

export async function latexmk(opts: LatexmkOptions): Promise<LatexmkResult> {
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0))
    throw new Error('Invalid timeoutMs');
  if (
    typeof opts.rerun === 'object' &&
    opts.rerun !== null &&
    !Number.isSafeInteger(opts.rerun.maxPasses)
  )
    throw new Error('maxPasses must be a finite integer');
  const stripExt = (p: string) => p.replace(/\.tex$/i, '');
  // TeX writes all outputs into the cwd under the jobname (= input basename),
  // even when mainTex lives in a subdirectory — key everything by basename.
  const base = stripExt(opts.mainTex).split('/').pop()!;
  const auxPath = `${base}.aux`;
  const bcfPath = `${base}.bcf`;
  const idxPath = `${base}.idx`;
  const xdvPath = `${base}.xdv`;
  const pdfPath = `${base}.pdf`;
  const logPath = `${base}.log`;
  const synctexPath = `${base}.synctex.gz`;

  const logs: LogEntry[] = [];
  const isXetex = opts.engine === 'xelatex';

  const sources = reachableSources(opts.files, opts.mainTex);
  const biblatexMode = usesBiblatex(sources);

  const rerunMode = opts.rerun ?? 'auto';
  const maxPasses =
    rerunMode === false
      ? 1
      : typeof rerunMode === 'object'
        ? Math.max(1, rerunMode.maxPasses)
        : biblatexMode
          ? BIBLATEX_MAX_PASSES
          : DEFAULT_MAX_PASSES;

  // Detect bibtex/biber/makeindex from sources if 'auto'.
  const needBibtex = resolveAuto(opts.bibtex, () => detectBibtex(sources, biblatexMode));
  // biber serves default-backend biblatex docs; mutually exclusive with the
  // bibtex path (backend=bibtex routes through bibtexu instead).
  const needBiber =
    !needBibtex && resolveAuto(opts.biber, () => biblatexMode && !biblatexBackendIsBibtex(sources));
  const needMakeindex = resolveAuto(opts.makeindex, () => willRunMakeindex(sources));

  const texExtraArgs = opts.synctex ? ['-synctex=1'] : [];

  let lastAux: string | null = null;
  let lastBcf: string | null = null;
  let lastBibAux: string | null = null;
  let lastIdx: string | null = null;
  let pass = 0;
  let converged = false;
  let pendingRerun = false;
  let exitCode = 0;
  let outputs = new Map<string, Uint8Array>();

  // Everything the next engine invocation needs on disk: the caller's
  // sources overlaid with all generated files so far (fresh .aux/.bbl/.ind
  // win over any same-named input).
  const materialize = (): FileInput[] => {
    const merged = new Map<string, FileInput>();
    for (const f of opts.files) merged.set(f.path.replace(/^\/+/, ''), f);
    for (const [path, content] of outputs) merged.set(path, { path, content });
    return [...merged.values()];
  };

  const tex = buildTexEngine(opts);
  // Helper wrappers are created lazily, at most once, and disposed at the
  // end (dispose() is a no-op for wrappers borrowing a caller handle).
  let bibtexWrapper: Bibtexu | null = null;
  let biberWrapper: Biber | null = null;
  let makeindexWrapper: Makeindex | null = null;
  let xdvipdfmxWrapper: Xdvipdfmx | null = null;

  const pushLog = (cmd: string, r: RunResult) => {
    logs.push({ cmd, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, log: r.log });
  };

  // The deadline covers the pipeline, not one invocation: each engine call
  // gets whatever is left of it, so extra passes cannot extend it.
  const deadline =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? performance.now() + opts.timeoutMs : null;
  const budget = (): RunLimits => {
    const limits: RunLimits = opts.timeoutMs === 0 ? { timeoutMs: 0 } : {};
    if (opts.signal?.aborted) throw new Error('latexmk: pipeline aborted');
    if (opts.signal) limits.signal = opts.signal;
    if (deadline !== null) {
      const left = Math.ceil(deadline - performance.now());
      if (left <= 0) {
        throw new Error(`latexmk: pipeline exceeded timeoutMs=${opts.timeoutMs}`);
      }
      limits.timeoutMs = left;
    }
    return limits;
  };

  try {
    while (pass < maxPasses) {
      pass++;
      const result = await tex.compile({
        mainTex: opts.mainTex,
        files: pass === 1 ? opts.files : materialize(),
        extraArgs: texExtraArgs,
        ...budget(),
        // XeTeX in WASM cannot spawn xdvipdfmx itself (no popen); we always
        // hold the .xdv and finalize with our own xdvipdfmx pass below.
        ...(isXetex ? { noPdf: true } : {}),
      });
      pushLog(`${opts.engine} ${opts.mainTex}`, result);
      exitCode = result.exitCode;
      outputs = mergeOutputs(outputs, result.outputs);
      if (exitCode !== 0) break;

      let helpersRan = false;

      // Bibtex on the first pass that produced an .aux.
      if (
        needBibtex &&
        outputs.has(auxPath) &&
        bytesToString(outputs.get(auxPath)) !== lastBibAux
      ) {
        lastBibAux = bytesToString(outputs.get(auxPath));
        bibtexWrapper ??= new Bibtexu(wrapperConfig(opts, 'bibtexu', opts.handles?.bibtex));
        const r = await bibtexWrapper.run({
          auxFile: auxPath,
          files: materialize(),
          ...budget(),
          // biblatex's aux needs bibtex8's "wolfgang" capacity mode; the
          // switch is harmless for classic .bst documents but only biblatex
          // requires it, so keep classic invocations byte-identical.
          ...(biblatexMode ? { extraArgs: ['--wolfgang'] } : {}),
        });
        pushLog(`bibtexu ${auxPath}`, r);
        outputs = mergeOutputs(outputs, r.outputs);
        // bibtex exit statuses: 0 spotless, 1 warnings, 2 errors, 3 fatal.
        // Warnings are routine (empty fields etc.) and must not abort.
        if (r.exitCode >= 2) {
          exitCode = r.exitCode;
          break;
        }
        helpersRan = true;
      }

      // Biber whenever the .bcf appeared or changed — biblatex rewrites the
      // control file when options/citations change; a stable .bcf means
      // biber's work is already reflected in the .bbl.
      if (needBiber && outputs.has(bcfPath)) {
        const bcfNow = bytesToString(outputs.get(bcfPath));
        if (bcfNow !== lastBcf) {
          lastBcf = bcfNow;
          biberWrapper ??= new Biber(wrapperConfig(opts, 'biber', opts.handles?.biber));
          const r = await biberWrapper.run({ jobname: base, files: materialize(), ...budget() });
          pushLog(`biber ${base}`, r);
          outputs = mergeOutputs(outputs, r.outputs);
          // biber exits 0 on success (warnings included); >=2 is a hard error.
          if (r.exitCode >= 2) {
            exitCode = r.exitCode;
            break;
          }
          helpersRan = true;
        }
      }

      // Makeindex whenever the .idx appeared or changed.
      if (needMakeindex && outputs.has(idxPath)) {
        const idxNow = bytesToString(outputs.get(idxPath));
        if (idxNow !== lastIdx) {
          lastIdx = idxNow;
          makeindexWrapper ??= new Makeindex(
            wrapperConfig(opts, 'makeindex', opts.handles?.makeindex),
          );
          const r = await makeindexWrapper.run({
            idxFile: idxPath,
            files: materialize(),
            ...budget(),
          });
          pushLog(`makeindex ${idxPath}`, r);
          outputs = mergeOutputs(outputs, r.outputs);
          // A failed makeindex used to be swallowed: the document still built,
          // but with a stale or missing index and success:true — a wrong
          // document reported as a right one. makeindex exits non-zero only on
          // real errors (a bad style file, unreadable .idx), so treat it like
          // every other helper failure.
          if (r.exitCode !== 0) {
            exitCode = r.exitCode;
            break;
          }
          helpersRan = true;
        }
      }

      const aux = bytesToString(outputs.get(auxPath));
      const log = bytesToString(outputs.get(logPath));
      const rerunRequested = RERUN_PATTERNS.some((re) => re.test(log));
      const auxStable = lastAux !== null && aux === lastAux;
      const hadAux = lastAux !== null;
      lastAux = aux;
      pendingRerun = helpersRan || rerunRequested || (hadAux && !auxStable);
      converged = !helpersRan && !rerunRequested && (auxStable || rerunMode === false);
      // A fresh .bbl/.ind must be folded in by at least one more pass.
      if (helpersRan) continue;
      if (auxStable && !rerunRequested) break;
    }

    // For xelatex, finalize via xdvipdfmx on the held .xdv.
    if (isXetex && exitCode === 0 && outputs.has(xdvPath)) {
      xdvipdfmxWrapper ??= new Xdvipdfmx(wrapperConfig(opts, 'xdvipdfmx', opts.handles?.xdvipdfmx));
      const r = await xdvipdfmxWrapper.run({
        xdv: xdvPath,
        pdf: pdfPath,
        files: materialize(),
        ...budget(),
      });
      pushLog(`xdvipdfmx -o ${pdfPath} ${xdvPath}`, r);
      outputs = mergeOutputs(outputs, r.outputs);
      if (r.exitCode !== 0) exitCode = r.exitCode;
    }
  } finally {
    // Wrappers created by this call own their workers; release them. A
    // wrapper wrapping a caller-supplied handle no-ops its dispose().
    await Promise.allSettled(
      [tex, bibtexWrapper, biberWrapper, makeindexWrapper, xdvipdfmxWrapper]
        .filter((w) => w !== null)
        .map((w) => w.dispose()),
    );
  }

  const result: LatexmkResult = {
    success: exitCode === 0 && outputs.has(pdfPath) && (rerunMode === false || !pendingRerun),
    log: bytesToString(outputs.get(logPath)),
    logs,
    exitCode,
    passes: pass,
    converged: exitCode === 0 && converged,
    maxPassesReached: rerunMode !== false && exitCode === 0 && pass >= maxPasses && pendingRerun,
  };
  const pdf = outputs.get(pdfPath);
  if (pdf) result.pdf = pdf;
  const synctex = outputs.get(synctexPath);
  if (synctex) result.synctex = synctex;
  return result;
}

function resolveAuto<T extends boolean | 'auto' | undefined>(
  value: T,
  autoFn: () => boolean,
): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return autoFn();
}

/** Follow literal local inputs/packages; dynamic TeX inputs keep conservative scanning. */
function reachableSources(files: FileInput[], mainTex?: string): FileInput[] {
  if (!mainTex) return files;
  const key = (path: string) =>
    path
      .replace(/\\/g, '/')
      .replace(/^\/project\//, '')
      .replace(/^\.\//, '');
  const index = new Map(files.map((file) => [key(file.path), file]));
  const first = index.get(key(mainTex));
  if (!first) return files;
  const visited = new Set<FileInput>();
  const queue = [first];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = sourceText(file);
    if (/\\(?:input|include|subfile)\s*(?![\s{])[\\]/.test(text)) return files;
    const pattern =
      /\\(input|include|subfile|usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*(?:\{([^}]+)\}|([^\s\\{}%]+))/g;
    for (const match of text.matchAll(pattern)) {
      const ext =
        /package/.test(match[1]!) || match[1] === 'RequirePackage'
          ? '.sty'
          : /class/i.test(match[1]!)
            ? '.cls'
            : '.tex';
      for (const name of (match[2] ?? match[3]!).split(',').map((s) => s.trim())) {
        if (name.includes('\\') || name.includes('..')) return files;
        const path = /\.[^/]+$/.test(name) ? name : name + ext;
        const dir = key(file.path).split('/').slice(0, -1).join('/');
        const dependency = index.get(key(path)) ?? index.get(key(dir ? `${dir}/${path}` : path));
        if (dependency) queue.push(dependency);
      }
    }
  }
  return [...visited];
}

/** Source-only heuristic; generated control files remain the authoritative engine inputs. */
function sourceText(file: FileInput): string {
  if (!/\.(tex|ltx|sty|cls)$/i.test(file.path)) return '';
  return stripTexComments(contentToString(file.content));
}

export function stripTexComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '%') continue;
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
        if (slashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

function contentToString(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  return new TextDecoder('utf-8', { fatal: false }).decode(content);
}

// Matches \usepackage[opts]{biblatex} / \RequirePackage[opts]{biblatex};
// character classes match newlines, so multi-line option lists work.
const BIBLATEX_LOAD = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{\s*biblatex\s*\}/;
const BIBLATEX_PASS_OPTS = /\\PassOptionsToPackage\s*\{([^}]*)\}\s*\{\s*biblatex\s*\}/;
const BACKEND_BIBTEX = /backend\s*=\s*bibtex8?\s*(?:[,\]}]|$)/m;

function usesBiblatex(files: FileInput[]): boolean {
  return files.some((f) => BIBLATEX_LOAD.test(sourceText(f)));
}

function biblatexBackendIsBibtex(files: FileInput[]): boolean {
  return files.some((f) => {
    const text = sourceText(f);
    const load = BIBLATEX_LOAD.exec(text);
    if (load?.[1] && BACKEND_BIBTEX.test(load[1])) return true;
    const pass = BIBLATEX_PASS_OPTS.exec(text);
    return pass?.[1] !== undefined && BACKEND_BIBTEX.test(pass[1]);
  });
}

/**
 * Public preview of latexmk's bibtex auto-detection. Apps that manage their
 * own EngineHandles (to pass `handles.bibtex` with a configured enginePath)
 * can ask up front whether a compile will invoke bibtexu, instead of
 * duplicating the detection heuristics.
 */
export function willRunBibtex(files: FileInput[], mainTex?: string): boolean {
  const sources = reachableSources(files, mainTex);
  return detectBibtex(sources, usesBiblatex(sources));
}

/** Same preview for biber: default-backend biblatex documents. */
export function willRunBiber(files: FileInput[], mainTex?: string): boolean {
  const sources = reachableSources(files, mainTex);
  return usesBiblatex(sources) && !biblatexBackendIsBibtex(sources);
}

function detectBibtex(files: FileInput[], biblatexMode: boolean): boolean {
  // biblatex docs: bibtexu can process the aux only for backend=bibtex
  // setups (biblatex also aliases \bibliography to \addbibresource, so the
  // classic marker alone must NOT trigger bibtexu on a biber-backend doc).
  // The default biber backend is left alone until biber.wasm ships.
  if (biblatexMode) return biblatexBackendIsBibtex(files);
  // Classic bibtex: `\bibliography{…}` writes the aux bibtexu processes.
  return files.some((f) => sourceText(f).includes('\\bibliography{'));
}

export function willRunMakeindex(files: FileInput[], mainTex?: string): boolean {
  return reachableSources(files, mainTex).some((f) => {
    const text = sourceText(f);
    return text.includes('\\makeindex') || text.includes('\\printindex');
  });
}

function bytesToString(bytes: Uint8Array | undefined): string {
  if (!bytes) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function mergeOutputs(
  base: Map<string, Uint8Array>,
  add: Map<string, Uint8Array>,
): Map<string, Uint8Array> {
  for (const [k, v] of add) base.set(k, v);
  return base;
}

/**
 * Options for one wrapper: a caller-supplied handle wins; otherwise the
 * engine is built from `engineConfig`, which is the only way this driver can
 * know where the engine's .wasm lives.
 */
function wrapperConfig(
  opts: LatexmkOptions,
  id: EngineId,
  handle: EngineHandle | undefined,
): EngineWrapperConfig {
  if (handle) return { engine: handle };
  const config =
    typeof opts.engineConfig === 'function' ? opts.engineConfig(id) : (opts.engineConfig ?? {});
  const { useWorker: _useWorker, ...wrapperSafe } = config;
  return {
    ...wrapperSafe,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  };
}

type EngineWrapperConfig = Omit<EngineConfig, 'useWorker'> & { engine?: EngineHandle };

function buildTexEngine(opts: LatexmkOptions): PdfLatex | XeLatex | LuaLatex {
  const config = wrapperConfig(opts, opts.engine, opts.handles?.tex);
  if (opts.engine === 'pdflatex') return new PdfLatex(config);
  if (opts.engine === 'xelatex') return new XeLatex(config);
  return new LuaLatex(config);
}
