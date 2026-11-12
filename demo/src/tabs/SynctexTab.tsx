/**
 * SyncTeX demo: compiles a two-file project with -synctex=1 and parses the
 * resulting .synctex.gz with the library's JS parser. Honest about scope:
 * the UI lists input files; the library also exposes forward/reverse position queries.
 */

import { For, Show, createSignal } from 'solid-js';
import { createSynctex } from '@typeward/texlive-wasm';
import { CompilePanel } from '../CompilePanel';
import { SYNCTEX } from '../samples';

export function SynctexTab() {
  const [files, setFiles] = createSignal<string[]>([]);
  const [note, setNote] = createSignal('');

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', flex: '1', 'min-height': '0' }}>
      <CompilePanel
        sample={SYNCTEX}
        synctex={true}
        intro={
          <>
            The engine runs with <code>-synctex=1</code> and emits a compressed{' '}
            <code>.synctex.gz</code> alongside the PDF. <code>createSynctex()</code> gunzips and
            parses it in JS. The library exposes forward/reverse position queries in PDF points;
            this view shows the input-file list.
          </>
        }
        onResult={async (result) => {
          if (!result.synctex) {
            setFiles([]);
            setNote('no .synctex.gz produced');
            return;
          }
          const lookup = await createSynctex(result.synctex);
          setFiles(lookup.files().sort());
          setNote(`${(result.synctex.length / 1024).toFixed(1)} KB .synctex.gz`);
        }}
      />
      <Show when={files().length > 0 || note()}>
        <div
          style={{
            padding: '8px 12px',
            'border-top': '1px solid #ddd',
            'font-size': '13px',
            background: '#fafafa',
          }}
        >
          <strong>SyncTeX input files</strong> <span style={{ color: '#888' }}>({note()})</span>
          <ul style={{ margin: '4px 0 0 0', 'padding-left': '20px' }}>
            <For each={files()}>{(f) => <li style={{ 'font-family': 'monospace' }}>{f}</li>}</For>
          </ul>
        </div>
      </Show>
    </div>
  );
}
