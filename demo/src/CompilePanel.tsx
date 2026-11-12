/**
 * Reusable editor → PDF panel. Left: file editor (with a file switcher for
 * multi-file samples) + compile button + status + log tail. Right: pdf.js
 * viewer. All compilation goes through engine-manager (the texlive-wasm API).
 */

import { For, Show, createEffect, createSignal, on, type JSX } from 'solid-js';
import type { LatexmkResult } from '@typeward/texlive-wasm';
import { PdfViewer } from './PdfViewer';
import { compile } from './engine-manager';
import type { Sample } from './samples';

export interface CompilePanelProps {
  sample: Sample;
  synctex?: boolean;
  /** Explanatory copy rendered above the editor. */
  intro?: JSX.Element;
  /** Render the per-step invocation list (proves multi-engine pipelines). */
  showSteps?: boolean;
  onResult?: (result: LatexmkResult) => void;
}

export function CompilePanel(props: CompilePanelProps) {
  const [contents, setContents] = createSignal<Record<string, string>>({});
  const [activePath, setActivePath] = createSignal('');
  const [pdfUrl, setPdfUrl] = createSignal<string | null>(null);
  const [log, setLog] = createSignal('');
  const [steps, setSteps] = createSignal<string[]>([]);
  const [status, setStatus] = createSignal('ready');
  const [busy, setBusy] = createSignal(false);

  // (Re)load the panel whenever a different sample is injected.
  createEffect(
    on(
      () => props.sample.id,
      () => {
        const next: Record<string, string> = {};
        for (const f of props.sample.files) next[f.path] = f.content;
        setContents(next);
        setActivePath(props.sample.mainTex);
        setPdfUrl(null);
        setLog('');
        setSteps([]);
        setStatus('ready');
      },
    ),
  );

  async function run() {
    setBusy(true);
    setStatus('compiling…');
    setLog('');
    setSteps([]);
    try {
      const t0 = performance.now();
      const result = await compile({
        preview: true,
        onEvent(event) {
          setStatus(`${event.type}: pass ${event.pass}, ${event.elapsedMs.toFixed(0)} ms`);
          if (event.type === 'preview' && event.pdf) {
            const old = pdfUrl();
            if (old) URL.revokeObjectURL(old);
            setPdfUrl(URL.createObjectURL(new Blob([event.pdf as BlobPart], {type: 'application/pdf'})));
          }
        },
        engine: props.sample.engine,
        mainTex: props.sample.mainTex,
        files: Object.entries(contents()).map(([path, content]) => ({ path, content })),
        ...(props.synctex ? { synctex: true } : {}),
      });
      const ms = performance.now() - t0;
      setSteps(result.logs.map((l) => `${l.cmd}  →  exit ${l.exitCode}`));
      const tail = (result.log || result.logs.at(-1)?.stdout || '(no log)')
        .split('\n')
        .slice(-30)
        .join('\n');
      setLog(tail);
      if (result.pdf) {
        const blob = new Blob([result.pdf as BlobPart], { type: 'application/pdf' });
        const old = pdfUrl();
        if (old) URL.revokeObjectURL(old);
        setPdfUrl(URL.createObjectURL(blob));
        setStatus(
          `done in ${ms.toFixed(0)} ms — ${result.passes} pass${result.passes === 1 ? '' : 'es'}, ` +
            `${(result.pdf.length / 1024).toFixed(1)} KB PDF`,
        );
      } else {
        setStatus(`failed (exit ${result.exitCode}, ${ms.toFixed(0)} ms) — see log`);
      }
      props.onResult?.(result);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
      setLog((err as Error).stack ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flex: '1', 'min-height': '0' }}>
      <div
        style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          padding: '12px',
          gap: '8px',
          'min-width': '0',
        }}
      >
        <Show when={props.intro}>
          <div style={{ 'font-size': '13px', color: '#555', 'line-height': '1.5' }}>
            {props.intro}
          </div>
        </Show>
        <Show when={props.sample.files.length > 1}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <For each={props.sample.files}>
              {(f) => (
                <button
                  onClick={() => setActivePath(f.path)}
                  style={{
                    padding: '3px 10px',
                    'font-size': '12px',
                    'font-family': 'monospace',
                    border: '1px solid #ccc',
                    'border-bottom':
                      activePath() === f.path ? '2px solid #2f3e55' : '1px solid #ccc',
                    background: activePath() === f.path ? '#fff' : '#f2f2f2',
                    cursor: 'pointer',
                  }}
                >
                  {f.path}
                </button>
              )}
            </For>
          </div>
        </Show>
        <textarea
          value={contents()[activePath()] ?? ''}
          onInput={(e) =>
            setContents({ ...contents(), [activePath()]: e.currentTarget.value })
          }
          spellcheck={false}
          style={{
            flex: '1',
            'font-family': '"SF Mono", Menlo, Consolas, monospace',
            'font-size': '13px',
            border: '1px solid #ddd',
            padding: '8px',
            resize: 'none',
          }}
        />
        <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
          <button
            onClick={run}
            disabled={busy()}
            style={{
              padding: '8px 20px',
              'font-size': '14px',
              cursor: busy() ? 'wait' : 'pointer',
              background: '#2f3e55',
              color: '#fff',
              border: 'none',
              'border-radius': '4px',
            }}
          >
            {busy() ? 'Working…' : `Compile (${props.sample.engine})`}
          </button>
          <span style={{ 'font-size': '12px', color: '#666' }}>{status()}</span>
        </div>
        <Show when={props.showSteps && steps().length > 0}>
          <div style={{ 'font-size': '12px' }}>
            <strong>Pipeline:</strong>
            <ol style={{ margin: '4px 0 0 0', 'padding-left': '20px' }}>
              <For each={steps()}>
                {(s) => <li style={{ 'font-family': 'monospace' }}>{s}</li>}
              </For>
            </ol>
          </div>
        </Show>
        <Show when={log()}>
          <pre
            style={{
              'max-height': '140px',
              overflow: 'auto',
              background: '#f7f7f7',
              padding: '8px',
              margin: '0',
              'font-size': '11px',
              'white-space': 'pre-wrap',
              border: '1px solid #e0e0e0',
            }}
          >
            {log()}
          </pre>
        </Show>
      </div>
      <div style={{ flex: '1', 'border-left': '1px solid #ccc', 'min-width': '0' }}>
        <PdfViewer pdfUrl={pdfUrl()} />
      </div>
    </div>
  );
}
