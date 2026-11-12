import { binaryText } from './state';
import { sha256Hex } from '../core/manifest';
import { createEngineManager, type EngineManagerOptions } from '../core/manager';
import type { EngineId, FileInput } from '../core/types';
import {
  latexmk,
  willRunBibtex,
  willRunBiber,
  willRunMakeindex,
  type LatexmkOptions,
  type LatexmkResult,
} from './index';

export interface CompileSessionOptions extends EngineManagerOptions {
  /** Change this identifier when external TDS/font resources change. */
  resourceVersion: string;
}
export type SessionCompileOptions = Omit<
  LatexmkOptions,
  'handles' | 'engineConfig' | 'incremental'
>;
export interface CompileSession {
  compile(options: SessionCompileOptions): Promise<LatexmkResult>;
  clear(): void;
  dispose(): Promise<void>;
}

/** Serialized incremental project session; no global or cross-project cache. */
export function createCompileSession(options: CompileSessionOptions): CompileSession {
  let active: { deadline: number | null; signal?: AbortSignal } | undefined;
  const manager = createEngineManager({
    ...options,
    config: (id) => {
      const config = options.config(id);
      const remaining =
        active?.deadline === null || active?.deadline === undefined
          ? null
          : Math.max(1, Math.ceil(active.deadline - performance.now()));
      return {
        ...config,
        ...(remaining !== null
          ? {
              initTimeoutMs:
                config.initTimeoutMs && config.initTimeoutMs > 0
                  ? Math.min(config.initTimeoutMs, remaining)
                  : remaining,
            }
          : {}),
        ...(active?.signal ? { initSignal: active.signal } : {}),
      };
    },
  });
  let previous: { key: string; sourceKey: string; files: FileInput[] } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let generation = 0;
  const copy = (f: FileInput): FileInput => ({
    path: f.path,
    content: typeof f.content === 'string' ? f.content : f.content.slice(),
  });
  return {
    compile(input) {
      if (disposed) return Promise.reject(new Error('Compile session is disposed'));
      // Snapshot before queueing: callers may edit their arrays while a compile runs.
      const opts = { ...input, files: input.files.map(copy) };
      const run = async () => {
        if (
          opts.timeoutMs !== undefined &&
          (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0)
        )
          throw new Error('Invalid timeoutMs');
        if (opts.signal?.aborted) throw new Error('Compile session aborted');
        const deadline =
          opts.timeoutMs && opts.timeoutMs > 0 ? performance.now() + opts.timeoutMs : null;
        active = { deadline, ...(opts.signal ? { signal: opts.signal } : {}) };
        const startedGeneration = generation;
        // Source edits can reuse auxiliaries; changed file sets, assets, engines,
        // environment or external resources require a pristine project state.
        const key = JSON.stringify([
          options.resourceVersion,
          opts.engine,
          opts.mainTex,
          opts.processEnv,
          opts.files
            .filter((f) => /\.(tex|ltx)$/i.test(f.path))
            .map((f) => {
              const source = typeof f.content === 'string' ? f.content : binaryText(f.content);
              const start = source.indexOf('\\begin{document}');
              return [
                f.path,
                start < 0 ? '' : source.slice(0, start),
                [
                  ...source.matchAll(
                    /\\(?:includeonly|input|include|bibliography|makeindex|makeglossaries)\b[^\n]*/g,
                  ),
                ].map((m) => m[0]),
              ];
            }),
          (
            await Promise.all(
              opts.files.map(async (f) => [
                f.path,
                /\.(tex|ltx)$/i.test(f.path)
                  ? null
                  : await sha256Hex(
                      typeof f.content === 'string'
                        ? new TextEncoder().encode(f.content)
                        : f.content,
                    ),
              ]),
            )
          ).sort(([a], [b]) => String(a).localeCompare(String(b))),
        ]);
        const sourceKey = await sha256Hex(
          new TextEncoder().encode(
            JSON.stringify(
              opts.files
                .filter((f) => /\.(tex|ltx)$/i.test(f.path))
                .map((f) => [
                  f.path,
                  typeof f.content === 'string' ? f.content : binaryText(f.content),
                ]),
            ),
          ),
        );
        const originalFiles = opts.files;
        const seeds =
          previous?.key === key && !opts.tools
            ? previous.files.filter(
                (f) =>
                  previous!.sourceKey === sourceKey ||
                  /\.(aux|toc|out|nav|snm|lof|lot|lol)$/.test(f.path),
              )
            : [];
        const merged = new Map(seeds.map((f) => [f.path, copy(f)]));
        for (const f of originalFiles) merged.set(f.path, f);
        const ids: EngineId[] = [opts.engine];
        if (opts.engine === 'xelatex') ids.push('xdvipdfmx');
        if (
          opts.bibtex === true ||
          (opts.bibtex !== false && willRunBibtex(originalFiles, opts.mainTex))
        )
          ids.push('bibtexu');
        if (
          opts.biber === true ||
          (opts.biber !== false &&
            !ids.includes('bibtexu') &&
            willRunBiber(originalFiles, opts.mainTex))
        )
          ids.push('biber');
        const glossary = originalFiles.some((f) =>
          /\\(?:makeglossaries|newglossary)/.test(
            typeof f.content === 'string' ? f.content : binaryText(f.content),
          ),
        );
        if (
          opts.makeindex === true ||
          (opts.makeindex !== false && willRunMakeindex(originalFiles, opts.mainTex)) ||
          (opts.glossaries !== false && glossary)
        )
          ids.push('makeindex');
        previous = undefined; // a failed/cancelled compile must not leave old seeds
        const result = await manager.withEngines(ids, async (handles) => {
          if (deadline !== null && performance.now() >= deadline)
            throw new Error('Compile session initialization exceeded timeoutMs');
          return latexmk({
            ...opts,
            ...(deadline !== null
              ? { timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) }
              : {}),
            incremental: seeds.length > 0,
            files: [...merged.values()],
            engineConfig: options.config,
            handles: {
              tex: handles.get(opts.engine)!,
              ...(handles.has('xdvipdfmx') ? { xdvipdfmx: handles.get('xdvipdfmx')! } : {}),
              ...(handles.has('bibtexu') ? { bibtex: handles.get('bibtexu')! } : {}),
              ...(handles.has('biber') ? { biber: handles.get('biber')! } : {}),
              ...(handles.has('makeindex') ? { makeindex: handles.get('makeindex')! } : {}),
            },
          });
        });
        if (result.complete && !opts.tools && generation === startedGeneration)
          previous = { key, sourceKey, files: result.auxiliaryFiles.map(copy) };
        return result;
      };
      const result = queue.then(run).finally(() => {
        active = undefined;
      });
      queue = result.catch(() => {});
      return result;
    },
    clear() {
      generation++;
      previous = undefined;
    },
    async dispose() {
      disposed = true;
      await queue;
      previous = undefined;
      await manager.dispose();
    },
  };
}
