import { describe, expect, it } from 'vitest';
import { latexmk } from '../src/latexmk';
import type { EngineHandle, EngineId, RunOptions, RunResult } from '../src/core/types';

const enc = (s: string) => new TextEncoder().encode(s);

interface Call {
  n: number;
  args: string[];
  files: Map<string, string>;
}

/**
 * Scripted fake engine handle. `script` receives the per-handle invocation
 * count (1-based) plus argv/files and returns the outputs + exit code —
 * mimicking the real worker, whose /project holds exactly `opts.files`.
 */
function fakeHandle(
  id: EngineId,
  script: (call: Call) => { exitCode?: number; outputs?: Record<string, string> },
): EngineHandle & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    id,
    config: {},
    calls,
    async run(options: RunOptions): Promise<RunResult> {
      const files = new Map<string, string>();
      for (const f of options.files ?? []) {
        files.set(
          f.path,
          typeof f.content === 'string' ? f.content : new TextDecoder().decode(f.content),
        );
      }
      const call: Call = { n: calls.length + 1, args: options.args, files };
      calls.push(call);
      const r = script(call);
      const outputs = new Map<string, Uint8Array>();
      for (const [path, content] of Object.entries(r.outputs ?? {})) {
        outputs.set(path, enc(content));
      }
      return {
        exitCode: r.exitCode ?? 0,
        stdout: '',
        stderr: '',
        outputs,
        log: r.outputs?.['main.log'] ?? '',
        durationMs: 1,
      };
    },
    async dispose() {},
    isReady: () => true,
  };
}

describe('latexmk multi-pass orchestration', () => {
  it('feeds pass-1 state (sources + aux + bbl) into bibtex and pass 2', async () => {
    const tex = fakeHandle('pdflatex', ({ n, files }) => {
      if (n === 1) {
        expect(files.has('main.tex')).toBe(true);
        return { outputs: { 'main.aux': '\\citation{knuth}', 'main.log': 'ok', 'main.pdf': 'P1' } };
      }
      // Pass 2 must see the original source AND the bibtex-produced .bbl —
      // the worker wipes /project on every run, so latexmk re-materializes.
      expect(files.get('main.tex')).toContain('\\bibliography{refs}');
      expect(files.get('main.bbl')).toBe('BBL CONTENT');
      expect(files.get('refs.bib')).toContain('@book');
      return { outputs: { 'main.aux': '\\citation{knuth}', 'main.log': 'ok', 'main.pdf': 'P2' } };
    });
    const bibtex = fakeHandle('bibtexu', ({ files }) => {
      // bibtexu runs in its own worker: it needs the aux and the .bib.
      expect(files.get('main.aux')).toBe('\\citation{knuth}');
      expect(files.has('refs.bib')).toBe(true);
      // Exit 1 = warnings — routine, must not abort the pipeline.
      return { exitCode: 1, outputs: { 'main.bbl': 'BBL CONTENT' } };
    });

    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [
        { path: 'main.tex', content: '\\documentclass{article}\\bibliography{refs}' },
        { path: 'refs.bib', content: '@book{knuth, title={TAOCP}}' },
      ],
      handles: { tex, bibtex },
    });

    expect(bibtex.calls).toHaveLength(1);
    expect(tex.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(new TextDecoder().decode(result.pdf!)).toBe('P2');
  });

  it('aborts and reports failure when bibtex exits with a real error (>= 2)', async () => {
    const tex = fakeHandle('pdflatex', () => ({
      outputs: { 'main.aux': 'A', 'main.log': '', 'main.pdf': 'P' },
    }));
    const bibtex = fakeHandle('bibtexu', () => ({ exitCode: 2 }));

    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: '\\bibliography{refs}' }],
      handles: { tex, bibtex },
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(tex.calls).toHaveLength(1);
  });

  it('rerun: false forces a single pass', async () => {
    const tex = fakeHandle('pdflatex', () => ({
      outputs: {
        'main.aux': 'changing',
        'main.log': 'Rerun to get cross-references right',
        'main.pdf': 'P',
      },
    }));
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: 'no bib here' }],
      rerun: false,
      handles: { tex },
    });
    expect(tex.calls).toHaveLength(1);
    expect(result.passes).toBe(1);
    expect(result.success).toBe(true);
  });

  it("default rerun mode is 'auto': loops until the aux stabilizes", async () => {
    const tex = fakeHandle('pdflatex', ({ n }) => ({
      outputs: {
        'main.aux': n === 1 ? 'first' : 'stable',
        'main.log': n === 1 ? 'Rerun to get cross-references right' : 'clean',
        'main.pdf': `P${n}`,
      },
    }));
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: 'plain doc' }],
      handles: { tex },
    });
    // pass1 (aux=first, rerun requested) -> pass2 (aux=stable) -> pass3 (aux
    // stable vs pass2, clean log) -> stop.
    expect(result.passes).toBe(3);
    expect(result.success).toBe(true);
  });

  it('keys outputs by basename when mainTex sits in a subdirectory', async () => {
    const tex = fakeHandle('pdflatex', () => ({
      // TeX writes into the cwd under the jobname — basename, not sub/main.pdf.
      outputs: { 'main.aux': 'A', 'main.log': 'clean', 'main.pdf': 'SUBDIR PDF' },
    }));
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'sub/main.tex',
      files: [{ path: 'sub/main.tex', content: 'doc' }],
      handles: { tex },
    });
    expect(result.success).toBe(true);
    expect(new TextDecoder().decode(result.pdf!)).toBe('SUBDIR PDF');
  });

  it('detects bibtex markers inside Uint8Array file contents', async () => {
    const tex = fakeHandle('pdflatex', () => ({
      outputs: { 'main.aux': 'A', 'main.log': 'clean', 'main.pdf': 'P' },
    }));
    const bibtex = fakeHandle('bibtexu', () => ({ outputs: { 'main.bbl': 'B' } }));
    await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: enc('\\bibliography{refs}') }],
      handles: { tex, bibtex },
    });
    expect(bibtex.calls).toHaveLength(1);
  });

  it('does not auto-run bibtexu for biblatex/biber-only documents', async () => {
    const tex = fakeHandle('pdflatex', () => ({
      outputs: { 'main.aux': 'A', 'main.log': 'clean', 'main.pdf': 'P' },
    }));
    const bibtex = fakeHandle('bibtexu', () => ({}));
    await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: '\\addbibresource{refs.bib}\\printbibliography' }],
      handles: { tex, bibtex },
    });
    expect(bibtex.calls).toHaveLength(0);
  });

  it('auto-runs bibtexu with --wolfgang for biblatex backend=bibtex documents', async () => {
    const tex = fakeHandle('pdflatex', ({ n }) => ({
      outputs: { 'main.aux': 'A', 'main.log': 'clean', 'main.pdf': `P${n}` },
    }));
    const bibtex = fakeHandle('bibtexu', () => ({ outputs: { 'main.bbl': 'B' } }));
    await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [
        {
          path: 'main.tex',
          content:
            '\\usepackage[style=authoryear,\n  backend=bibtex]{biblatex}\n' +
            '\\addbibresource{refs.bib}\\printbibliography',
        },
      ],
      handles: { tex, bibtex },
    });
    expect(bibtex.calls).toHaveLength(1);
    // biblatex requires bibtex8's wolfgang capacity mode.
    expect(bibtex.calls[0]!.args).toEqual(['--wolfgang', 'main.aux']);
  });

  it('leaves biber-backend docs alone even when \\bibliography is used as an alias', async () => {
    const tex = fakeHandle('pdflatex', () => ({
      outputs: { 'main.aux': 'A', 'main.log': 'clean', 'main.pdf': 'P' },
    }));
    const bibtex = fakeHandle('bibtexu', () => ({}));
    await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [
        {
          path: 'main.tex',
          // biblatex treats \bibliography{...} as an \addbibresource alias —
          // the classic marker must not trigger bibtexu on a biber-backend doc.
          content: '\\usepackage[backend=biber]{biblatex}\\bibliography{refs}\\printbibliography',
        },
      ],
      biber: false, // isolate the bibtex-detection assertion
      handles: { tex, bibtex },
    });
    expect(bibtex.calls).toHaveLength(0);
  });

  it('auto-runs biber for default-backend biblatex docs when the .bcf appears', async () => {
    const tex = fakeHandle('pdflatex', ({ n, files }) => {
      if (n > 1) expect(files.get('main.bbl')).toBe('BBL FROM BIBER');
      return {
        outputs: {
          'main.aux': 'A',
          'main.bcf': 'BCF CONTENT', // stable across passes → biber runs once
          'main.log': 'clean',
          'main.pdf': `P${n}`,
        },
      };
    });
    const biber = fakeHandle('biber', ({ args, files }) => {
      // Wrapper argv: perl runs the bundled script, then --noconf + jobname.
      expect(args).toEqual(['/biber/bin/biber', '--noconf', 'main']);
      expect(files.get('main.bcf')).toBe('BCF CONTENT');
      return { outputs: { 'main.bbl': 'BBL FROM BIBER' } };
    });
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [
        {
          path: 'main.tex',
          content:
            '\\usepackage[style=authoryear]{biblatex}\\addbibresource{r.bib}\\printbibliography',
        },
      ],
      handles: { tex, biber },
    });
    expect(biber.calls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.passes).toBeGreaterThanOrEqual(2);
  });

  it('reruns biber when the .bcf changes and aborts on hard errors (>=2)', async () => {
    const tex = fakeHandle('pdflatex', ({ n }) => ({
      outputs: {
        'main.aux': 'A',
        'main.bcf': `BCF v${n}`, // changes each pass → biber follows until cap
        'main.log': 'clean',
        'main.pdf': `P${n}`,
      },
    }));
    const biber = fakeHandle('biber', ({ n }) =>
      n === 1 ? { outputs: { 'main.bbl': 'B1' } } : { exitCode: 2 },
    );
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: '\\usepackage{biblatex}\\printbibliography' }],
      handles: { tex, biber },
    });
    expect(biber.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('xelatex: holds the .xdv and finalizes via xdvipdfmx with the full file set', async () => {
    const tex = fakeHandle('xelatex', ({ args }) => {
      // The wrapper must pass --no-pdf (WASM xetex cannot popen xdvipdfmx).
      expect(args).toContain('--no-pdf');
      return { outputs: { 'main.aux': 'A', 'main.log': 'clean', 'main.xdv': 'XDV BYTES' } };
    });
    const xdvipdfmx = fakeHandle('xdvipdfmx', ({ files }) => {
      expect(files.get('main.xdv')).toBe('XDV BYTES');
      return { outputs: { 'main.pdf': 'FINAL PDF' } };
    });
    const result = await latexmk({
      engine: 'xelatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: 'doc' }],
      handles: { tex, xdvipdfmx },
    });
    expect(result.success).toBe(true);
    expect(new TextDecoder().decode(result.pdf!)).toBe('FINAL PDF');
    expect(xdvipdfmx.calls).toHaveLength(1);
  });

  it('fails the compile when makeindex fails, instead of shipping a stale index', async () => {
    const tex = fakeHandle('pdflatex', ({ n }) => ({
      outputs: {
        'main.aux': 'A',
        'main.log': 'clean',
        'main.idx': 'IDX',
        // A PDF exists — it just has the wrong (missing) index in it.
        'main.pdf': `P${n}`,
      },
    }));
    // makeindex exits non-zero on a real error (bad style file, unreadable .idx).
    const makeindex = fakeHandle('makeindex', () => ({ exitCode: 1 }));

    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: '\\makeindex\\printindex' }],
      handles: { tex, makeindex },
    });

    expect(makeindex.calls).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('runs makeindex when the .idx appears and feeds the .ind back in', async () => {
    const tex = fakeHandle('pdflatex', ({ n, files }) => {
      if (n > 1) expect(files.get('main.ind')).toBe('IND');
      return {
        outputs: {
          'main.aux': 'A',
          'main.log': 'clean',
          'main.idx': 'IDX',
          'main.pdf': `P${n}`,
        },
      };
    });
    const makeindex = fakeHandle('makeindex', ({ files }) => {
      expect(files.get('main.idx')).toBe('IDX');
      return { outputs: { 'main.ind': 'IND' } };
    });
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: '\\makeindex\\printindex' }],
      handles: { tex, makeindex },
    });
    expect(makeindex.calls).toHaveLength(1); // .idx unchanged on pass 2 → no rerun
    expect(result.success).toBe(true);
    expect(result.passes).toBeGreaterThanOrEqual(2);
  });
});

it('reports an exhausted pass budget without claiming convergence', async () => {
  const tex = fakeHandle('pdflatex', ({ n }) => ({
    outputs: {
      'main.pdf': 'PDF',
      'main.aux': String(n),
      'main.log': 'Rerun to get cross-references right',
    },
  }));
  const result = await latexmk({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: [],
    handles: { tex },
  });
  expect(result.converged).toBe(false);
  expect(result.maxPassesReached).toBe(true);
  expect(result.success).toBe(false);
  expect(result.pdf).toBeDefined();
});

it('reports convergence for stable auxiliary files', async () => {
  const tex = fakeHandle('pdflatex', () => ({ outputs: { 'main.pdf': 'PDF', 'main.aux': 'A' } }));
  const result = await latexmk({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: [],
    handles: { tex },
  });
  expect(result.converged).toBe(true);
  expect(result.maxPassesReached).toBe(false);
  expect(result.success).toBe(true);
});

it('reruns BibTeX when citations change after the first TeX pass', async () => {
  const tex = fakeHandle('pdflatex', ({ n, files }) => {
    if (n === 3) expect(files.get('main.bbl')).toBe('BBL-2');
    return { outputs: { 'main.aux': n === 1 ? 'citation A' : 'citation B', 'main.pdf': 'PDF' } };
  });
  const bibtex = fakeHandle('bibtexu', ({ n }) => ({ outputs: { 'main.bbl': `BBL-${n}` } }));
  const result = await latexmk({
    engine: 'pdflatex',
    mainTex: 'main.tex',
    files: [{ path: 'main.tex', content: '\\bibliography{refs}' }],
    handles: { tex, bibtex },
  });
  expect(result.success).toBe(true);
  expect(bibtex.calls).toHaveLength(2);
});

it('rejects non-finite pass budgets and invalid deadlines before acquiring an engine', async () => {
  const opts = { engine: 'pdflatex' as const, mainTex: 'main.tex', files: [] };
  await expect(latexmk({ ...opts, rerun: { maxPasses: Infinity } })).rejects.toThrow(
    'finite integer',
  );
  await expect(latexmk({ ...opts, timeoutMs: -1 })).rejects.toThrow('Invalid timeoutMs');
});
it('accepts an explicit disabled pipeline deadline', async () => {
  const tex = fakeHandle('pdflatex', () => ({
    outputs: { 'main.pdf': 'PDF', 'main.aux': 'stable' },
  }));
  expect(
    (
      await latexmk({
        engine: 'pdflatex',
        mainTex: 'main.tex',
        files: [],
        handles: { tex },
        timeoutMs: 0,
      })
    ).success,
  ).toBe(true);
});
