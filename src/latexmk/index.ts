/**
 * Multi-pass TeX orchestration with bibliography, named indexes, makeindex
 * glossaries, convergence diagnostics and explicit host-tool integrations.
 * Fresh engine instances receive the current project state on each pass.
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
import { diagnose, type CompileDiagnostic } from './diagnostics';
import { auxiliarySnapshot, bibliographySignature, indexJobs, binaryText } from './state';
import { analyzeProject, maskTex } from '../project/analyze';
import { safeRelativePath } from '../core/paths';
import { Xdvipdfmx } from '../engines/xdvipdfmx';

export type LatexmkEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileEvent {
  type: 'start' | 'prepare' | 'pass' | 'helper' | 'preview' | 'complete';
  elapsedMs: number;
  pass: number;
  command?: string;
  durationMs?: number;
  pdf?: Uint8Array;
  partial: boolean;
}
export interface LatexmkOptions {
  /** Synchronous progress observer; preview buffers are independent copies. */
  onEvent?: (event: CompileEvent) => void;
  /** Opt-in intermediate PDFs. Final result still requires convergence. */
  preview?: boolean;
  /** Compile selected literal include chapters, explicitly marked partial. */
  includeOnly?: string[];
  /** Activate exact font maps shipped with an optional font pack/project. */
  fontMaps?: string[];
  /** Static preflight is opt-in; it never rewrites caller sources. */
  preflight?: boolean;
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
  /** Run makeindex-based glossaries/acronyms (default: auto). */
  glossaries?: boolean | 'auto';
  /** Fail success when content diagnostics are present. Default: false. */
  strict?: boolean;
  /** Seeded auxiliaries match the previous successful project revision (sessions set this). */
  incremental?: boolean;
  /** Real process variables passed to the engine before startup. */
  processEnv?: Record<string, string>;
  /** Explicit host integration for converters, highlighters or validators. No shell is spawned. */
  tools?: (context: {
    phase: 'before' | 'auxiliary' | 'after';
    files: FileInput[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<FileInput[]>;
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
  partial: boolean;
  totalMs: number;
  timings: { command: string; durationMs: number }[];
  /** False when the final log reports missing content or unresolved references. */
  complete: boolean;
  diagnostics: CompileDiagnostic[];
  /** Generated reusable control files, never PDF/log or caller sources. */
  auxiliaryFiles: FileInput[];
  /** Whether auxiliary files stabilized without a rerun request. */
  converged: boolean;
  /** The pass cap prevented the requested convergence. */
  maxPassesReached: boolean;
  /** An auxiliary state oscillated instead of converging. */
  cycleDetected: boolean;
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
  const startedAt = performance.now();
  const partial = !!opts.includeOnly?.length;
  const emit = (event: Omit<CompileEvent, 'elapsedMs' | 'partial'>) =>
    opts.onEvent?.({ ...event, elapsedMs: performance.now() - startedAt, partial });
  if (
    (partial || opts.fontMaps?.length) &&
    (!safeRelativePath(opts.mainTex) ||
      /[{}\\\s%#$&^~,]/.test(opts.mainTex) ||
      opts.includeOnly?.some(
        (path) => safeRelativePath(path) !== path || /[{}\\\s%#$&^~,]/.test(path),
      ))
  )
    throw new Error('Invalid includeOnly paths');
  if (
    opts.fontMaps?.some((path) => safeRelativePath(path) !== path || !/^[\w./+-]+\.map$/.test(path))
  )
    throw new Error('Invalid font map path');
  if (opts.preflight) {
    const analysis = analyzeProject(opts.files, opts.mainTex);
    const errors = analysis.problems.filter((p) => p.severity === 'error');
    if (errors.length)
      throw new Error(
        'Project preflight: ' + errors.map((p) => `${p.file}:${p.line}: ${p.message}`).join('\n'),
      );
  }
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
  let engineInput = opts.mainTex;
  const prefix =
    (partial
      ? `\\includeonly{${opts.includeOnly!.map((p) => p.replace(/\.tex$/i, '')).join(',')}}`
      : '') +
    (opts.fontMaps ?? [])
      .map((p) =>
        opts.engine === 'pdflatex'
          ? `\\pdfmapfile{+${p}}`
          : opts.engine === 'lualatex'
            ? `\\pdfextension mapfile{+${p}}`
            : '',
      )
      .join('');
  if (prefix) {
    engineInput = prefix + `\\input{${opts.mainTex}}`;
    texExtraArgs.push(`-jobname=${base}`);
  }

  let lastAux: string | null = null;
  let lastBcf: string | null = null;
  let lastBibAux: string | null = null;
  const lastIndexes = new Map<string, string>();
  let pass = 0;
  let converged = false;
  let cycleDetected = false;
  const seenStates = new Set<string>();
  let pendingRerun = false;
  let exitCode = 0;
  let outputs = new Map<string, Uint8Array>(
    opts.files
      .filter((f) =>
        /\.(aux|toc|out|nav|snm|lof|lot|lol|bbl|bcf|run\.xml|idx|ind|glo|gls|acn|acr|ist)$/.test(
          f.path,
        ),
      )
      .map((f) => [
        f.path,
        typeof f.content === 'string' ? new TextEncoder().encode(f.content) : f.content,
      ]),
  );

  if (opts.incremental && outputs.has(auxPath)) {
    lastAux = auxiliarySnapshot(outputs);
    if (outputs.has(`${base}.bbl`)) {
      lastBibAux = bibliographySignature(outputs, auxPath);
      lastBcf = binaryText(outputs.get(bcfPath));
    }
    for (const job of indexJobs(outputs, needMakeindex, opts.glossaries !== false)) {
      if (outputs.has(job.output))
        lastIndexes.set(
          job.input,
          binaryText(outputs.get(job.input)) + '\0' + binaryText(outputs.get(job.style ?? '')),
        );
    }
  }

  // Everything the next engine invocation needs on disk: the caller's
  // sources overlaid with all generated files so far (fresh .aux/.bbl/.ind
  // win over any same-named input).
  const removedOutputs = new Set<string>();
  const materialize = (): FileInput[] => {
    const merged = new Map<string, FileInput>();
    for (const f of opts.files) {
      const path = f.path.replace(/^\/+/, '');
      if (!removedOutputs.has(path)) merged.set(path, f);
    }
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
    emit({
      type: cmd.startsWith(opts.engine) ? 'pass' : 'helper',
      pass,
      command: cmd,
      durationMs: r.durationMs,
    });
    logs.push({
      cmd,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      log: r.log,
      durationMs: r.durationMs,
    });
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

  const runTools = async (phase: 'before' | 'auxiliary' | 'after'): Promise<FileInput[]> => {
    if (!opts.tools) return [];
    const limits = budget();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => {
        controller.abort();
        reject(new Error('latexmk: host tools aborted'));
      };
      opts.signal?.addEventListener('abort', abort, { once: true });
      if (opts.signal?.aborted) abort();
      if (limits.timeoutMs && limits.timeoutMs > 0)
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('latexmk: host tools exceeded timeoutMs'));
        }, limits.timeoutMs);
    });
    try {
      return await Promise.race([
        opts.tools({ phase, files: materialize(), ...limits, signal: controller.signal }),
        stopped,
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) opts.signal?.removeEventListener('abort', abort);
    }
  };

  try {
    emit({ type: 'start', pass: 0 });
    if (opts.tools) {
      for (const file of await runTools('before')) {
        outputs.set(
          file.path,
          typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content,
        );
      }
    }
    while (pass < maxPasses) {
      pass++;
      const result = await tex.compile({
        mainTex: engineInput,
        files: materialize(),
        ...(opts.processEnv ? { processEnv: opts.processEnv } : {}),
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
      if (opts.preview && opts.onEvent && !isXetex && outputs.has(pdfPath))
        emit({ type: 'preview', pass, pdf: outputs.get(pdfPath)!.slice() });

      if (opts.preview && opts.onEvent && isXetex && outputs.has(xdvPath)) {
        xdvipdfmxWrapper ??= new Xdvipdfmx(
          wrapperConfig(opts, 'xdvipdfmx', opts.handles?.xdvipdfmx),
        );
        const preview = await xdvipdfmxWrapper.run({
          xdv: xdvPath,
          pdf: pdfPath,
          files: materialize(),
          extraArgs: (opts.fontMaps ?? []).flatMap((map) => ['-f', map]),
          ...budget(),
        });
        pushLog(`xdvipdfmx preview ${pass}`, preview);
        if (preview.exitCode === 0 && preview.outputs.has(pdfPath))
          emit({ type: 'preview', pass, pdf: preview.outputs.get(pdfPath)!.slice() });
      }

      let helpersRan = false;

      // Bibtex on the first pass that produced an .aux.
      if (
        needBibtex &&
        outputs.has(auxPath) &&
        bibliographySignature(outputs, auxPath) !== lastBibAux
      ) {
        lastBibAux = bibliographySignature(outputs, auxPath);
        removedOutputs.add(`${base}.bbl`);
        outputs.delete(`${base}.bbl`);
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
        const bcfNow = binaryText(outputs.get(bcfPath));
        if (bcfNow !== lastBcf) {
          lastBcf = bcfNow;
          removedOutputs.add(`${base}.bbl`);
          outputs.delete(`${base}.bbl`);
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

      // Discover every named index and each makeindex-based glossary from
      // the generated aux declarations, not from source command heuristics.
      for (const job of indexJobs(outputs, needMakeindex, opts.glossaries !== false)) {
        const signature =
          binaryText(outputs.get(job.input)) + '\0' + binaryText(outputs.get(job.style ?? ''));
        if (lastIndexes.get(job.input) === signature) continue;
        lastIndexes.set(job.input, signature);
        makeindexWrapper ??= new Makeindex(
          wrapperConfig(opts, 'makeindex', opts.handles?.makeindex),
        );
        removedOutputs.add(job.output);
        removedOutputs.add(job.transcript);
        outputs.delete(job.output);
        outputs.delete(job.transcript);
        const r = await makeindexWrapper.run({
          idxFile: job.input,
          output: job.output,
          ...(job.style ? { style: job.style } : {}),
          ...(job.glossary ? { extraArgs: ['-t', job.transcript] } : {}),
          files: materialize(),
          ...budget(),
        });
        pushLog(`makeindex ${job.input}`, r);
        outputs = mergeOutputs(outputs, r.outputs);
        helpersRan = true;
        if (r.exitCode !== 0) {
          exitCode = r.exitCode;
          break;
        }
      }
      if (exitCode !== 0) break;

      if (opts.tools) {
        for (const file of await runTools('auxiliary')) {
          const bytes =
            typeof file.content === 'string'
              ? new TextEncoder().encode(file.content)
              : file.content;
          const old = outputs.get(file.path);
          if (!old || old.length !== bytes.length || old.some((b, i) => b !== bytes[i])) {
            outputs.set(file.path, bytes);
            helpersRan = true;
          }
        }
      }

      const aux = auxiliarySnapshot(outputs);
      const log = bytesToString(outputs.get(logPath));
      const rerunRequested = RERUN_PATTERNS.some((re) => re.test(log));
      const auxStable = lastAux !== null && aux === lastAux;
      const hadAux = lastAux !== null;
      if (!helpersRan && lastAux !== null && aux !== lastAux && seenStates.has(aux)) {
        cycleDetected = true;
        pendingRerun = true;
        break;
      }
      // The current aux was produced before helpers changed the inputs.
      // Do not compare it with iterations evaluated against the new .bbl/.ind.
      if (helpersRan) seenStates.clear();
      else seenStates.add(aux);
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
        extraArgs: (opts.fontMaps ?? []).flatMap((map) => ['-f', map]),
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

  const finalLog = bytesToString(outputs.get(logPath));
  const diagnostics = diagnose(
    finalLog + '\n' + (logs.filter((l) => l.cmd.startsWith(opts.engine)).at(-1)?.stderr ?? ''),
  );
  for (const job of indexJobs(outputs, needMakeindex, opts.glossaries !== false)) {
    if (!outputs.has(job.output))
      diagnostics.push({
        code: 'missing-output',
        severity: 'error',
        message: `Expected generated output ${job.output} is missing.`,
      });
  }
  if (pendingRerun && rerunMode !== false)
    diagnostics.push({
      code: 'non-convergence',
      severity: 'error',
      message: cycleDetected
        ? 'Auxiliary files oscillate between previously seen states.'
        : 'Auxiliary files did not converge within the pass limit.',
    });
  const complete =
    exitCode === 0 &&
    outputs.has(pdfPath) &&
    diagnostics.length === 0 &&
    (rerunMode === false || converged);
  if (opts.tools && exitCode === 0 && outputs.has(pdfPath)) {
    for (const file of await runTools('after')) {
      outputs.set(
        file.path,
        typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content,
      );
    }
  }
  const result: LatexmkResult = {
    partial,
    totalMs: performance.now() - startedAt,
    timings: logs.map((log) => ({ command: log.cmd, durationMs: log.durationMs ?? 0 })),
    complete: complete && !partial,
    diagnostics,
    auxiliaryFiles: [...outputs]
      .filter(([path]) =>
        /\.(aux|toc|out|nav|snm|lof|lot|lol|bbl|bcf|run\.xml|idx|ind|glo|gls|acn|acr|ist)$/.test(
          path,
        ),
      )
      .map(([path, content]) => ({ path, content: content.slice() })),
    success:
      exitCode === 0 &&
      outputs.has(pdfPath) &&
      (rerunMode === false || !pendingRerun) &&
      (!opts.strict || complete),
    log: bytesToString(outputs.get(logPath)),
    logs,
    exitCode,
    passes: pass,
    converged: exitCode === 0 && converged,
    cycleDetected,
    maxPassesReached:
      rerunMode !== false && !cycleDetected && exitCode === 0 && pass >= maxPasses && pendingRerun,
  };
  const pdf = outputs.get(pdfPath);
  if (pdf) result.pdf = pdf;
  const synctex = outputs.get(synctexPath);
  if (synctex) result.synctex = synctex;
  emit({
    type: 'complete',
    pass,
    durationMs: result.totalMs,
    ...(opts.onEvent && result.pdf ? { pdf: result.pdf.slice() } : {}),
  });
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
  return maskTex(contentToString(file.content));
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
