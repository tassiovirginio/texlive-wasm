# texlive-wasm

> Pre-alpha. The wrapper API and CLI are stable enough to build against; the
> engine release tarballs are produced from a hard fork of TeX Live 2026.

Run TeX Live in WebAssembly. Compiles LaTeX → PDF in the browser and in a
Tauri / Capacitor mobile app, with one `.wasm` per engine.

**Runtime support today:** anywhere a Web Worker runs — browsers, the Tauri
WebView, Capacitor. **Node 20+ is supported using worker threads** with the Emscripten engines.
The WASI target remains experimental and is not part of published engine releases.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/live%20demo-typeward.github.io%2Ftexlive--wasm-2f3e55)](https://typeward.github.io/texlive-wasm/)

**[Try it in your browser →](https://typeward.github.io/texlive-wasm/)** — all seven
engines, compiled client-side, no server.

## Engines

Built against [TeX Live 2026](https://www.tug.org/texlive/) (`branch2026`,
commit `fb61589266`):

| Engine          | Artifact                  | Size    | Status                                                                |
| --------------- | ------------------------- | ------- | --------------------------------------------------------------------- |
| pdfLaTeX        | `pdflatex.wasm`           | 1.3 MB  | compiles `\documentclass{article}` → PDF (2.4 KB) end-to-end          |
| XeLaTeX         | `xelatex.wasm`            | 2.8 MB  | instantiates; ICU 78.2 wired                                          |
| LuaLaTeX        | `lualatex.wasm`           | 4.8 MB  | LuaHBTeX 1.24.0 instantiates                                          |
| BibTeXu         | `bibtexu.wasm`            | 877 KB  | runs                                                                  |
| biber           | `biber.wasm` (+14 MB VFS) | 9.1 MB  | biber 2.19 on Perl 5.42 — `.bbl` output byte-identical to native      |
| xdvipdfmx       | `xdvipdfmx.wasm`          | 765 KB  | instantiates                                                          |
| makeindex       | `makeindex.wasm`          | 192 KB  | instantiates                                                          |
| pdfLaTeX (WASI) | `pdflatex.wasm` (wasi-sdk)| 2.0 MB  | **not implemented** — the artifact builds locally, but no JS runner drives it and it is not published |

SyncTeX is built into every engine. The JS parser in `src/synctex/`
supports input-file listing and forward/reverse position queries in PDF points,
including compressed positions, multiple pages, PDF form references and postscript offsets.
Lookup uses nearest source lines and nearest page rectangles; it is not a drop-in
implementation of every selection heuristic in the native SyncTeX parser.

## Install

```bash
npm install @typeward/texlive-wasm
```

The npm package ships only the JS/TS wrapper (`dist/`) and the CLI.
**Engine `.wasm` files are not in the package** — they live on GitHub
Releases as compressed tarballs. Fetch them in a postinstall step or on
first run:

```bash
# default → ./public/texlive-wasm/
npx @typeward/texlive-wasm download-assets

# or specify a destination + pinned tag
npx @typeward/texlive-wasm download-assets --tag v0.1.0-alpha.0 ./static/texlive

# or a subset (skip 100 MB of TDS if you ship your own); names match
# checksums.json keys, the .tar.gz/.gz suffix may be omitted
npx @typeward/texlive-wasm download-assets --assets pdflatex-emscripten,icudt78l.dat
```

The CLI looks up `https://github.com/tassiovirginio/texlive-wasm/releases/download/<tag>/checksums.json`,
verifies SHA-256 of every downloaded blob against it, and unpacks the
`tar.gz` files into the destination.

Layout produced by `download-assets ./public/texlive-wasm/`:

```
public/texlive-wasm/
├── pdflatex/emscripten/pdflatex.{js,wasm,wasm.br,wasm.gz}
├── xelatex/emscripten/xelatex.{js,wasm,...}
├── lualatex/emscripten/lualatex.{js,wasm,...}
├── bibtexu/emscripten/bibtexu.{js,wasm,...}
├── xdvipdfmx/emscripten/xdvipdfmx.{js,wasm,...}
├── makeindex/emscripten/makeindex.{js,wasm,...}
├── icudt78l.dat          # ICU locale data (for xelatex + bibtexu)
└── texmf/                # core TDS slice (optional; ~360 MB unpacked)
```

## Version contract

One rule: **the wrapper's npm version, the engine-assets release tag, and
the manifest version are always the same.** `texlive-wasm@0.2.0` on npm
pairs with GitHub Release `v0.2.0`, and `npx @typeward/texlive-wasm download-assets`
defaults to exactly that tag (`v<package.json version>`).

Engine assets are only guaranteed to work with the same-version wrapper.
The SHA-256 checks against `checksums.json` enforce integrity; the version
rule enforces compatibility — mixing a wrapper from one release with
assets from another is unsupported.

The rule is enforced, not just documented. `download-assets` compares the
wrapper's version, the release tag and the `version` field inside that
release's `checksums.json`, and refuses to install a mismatched set
(`--allow-version-mismatch` downgrades it to a warning). `pack-release.mjs`
refuses to stamp a `checksums.json` under a version `package.json` does not
carry, and the release workflow rejects a tag that does not match
`package.json`.

Downstream apps (the Typeward app included) should pin an exact version —
`"@typeward/texlive-wasm": "0.3.1-alpha"`, no `^`/`~` — so the wrapper and its
assets can never drift apart across installs.

npm dist-tags follow the release channel: stable versions publish as `latest`,
`-alpha`/`-beta` prereleases under `next`.

**While the package is pre-1.0 there is no stable release yet, so `latest`
points at the current prerelease** — npm requires a `latest` tag and sets it on
the first publish, so a bare `npm install @typeward/texlive-wasm` resolves the
alpha today. The moment a stable version ships it takes over `latest` and
prereleases are reachable only via `@next`. Pin exactly and you are unaffected
either way.

## Asset integrity

A TDS bundle is the entire TeX tree the engine executes — its formats, its
config, every package a document can `\input`. The library therefore refuses
to load one it cannot pin:

- **Bundles** must either be same-origin (the app serving its own assets,
  including Tauri resources) or carry a SHA-256 — `coreBundleSha256` in the
  manifest, or `EngineConfig.bundleSha256`. A cross-origin bundle with no
  digest throws.
- **CDN and cached files** are checked against the manifest's per-file
  `sha256` on the way out of FetchFS and the OPFS cache; a mismatch is
  reported as a miss, never as bytes the engine sees. Setting `cdnBaseUrl`
  without a readable `manifestUrl` throws for the same reason.
- **Archives** are bounded (compressed size, expanded size, entry count) and
  every entry name is confined to the tree — `..`, absolute and duplicate
  entries are dropped.

`EngineConfig.allowUnverifiedAssets: true` turns the first two off. It is a
development escape hatch; do not ship it.

## Usage

### Basic — one engine, one file

```ts
import { PdfLatex } from '@typeward/texlive-wasm';

const pdflatex = new PdfLatex({
  enginePath: '/texlive-wasm/pdflatex/emscripten/pdflatex.wasm',
});

const result = await pdflatex.compile({
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: String.raw`
        \documentclass{article}
        \begin{document}
        Hello from TeX Live on WebAssembly.
        \end{document}
      `,
    },
  ],
});

if (result.exitCode === 0) {
  const pdf = result.outputs.get('main.pdf')!;
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  window.open(url);
} else {
  console.error(result.log);
}
```

### Multi-pass — bibtex + makeindex + rerun

`latexmk` drives several engines (the TeX engine plus bibtexu / biber /
makeindex / xdvipdfmx as the document needs them), and each is its own wasm
artifact — so it needs `engineConfig` to know where they live:

```ts
import { latexmk } from '@typeward/texlive-wasm';

const out = await latexmk({
  engine: 'pdflatex',
  mainTex: 'paper.tex',
  files: [
    { path: 'paper.tex', content: source },
    { path: 'refs.bib', content: bibtex },
  ],
  bibtex: true,
  makeindex: true,
  // One config for every engine latexmk builds; pass a function to vary it.
  engineConfig: (id) => ({
    enginePath: `/texlive-wasm/${id}/emscripten/${id}.wasm`,
    bundleUrl: `/texlive-wasm/texmf-core-${id}.tar.gz`,
  }),
  // Optional: a deadline for the whole pipeline, passes and helpers included.
  timeoutMs: 120_000,
});
```

Apps that keep engines alive across compiles should hand latexmk the handles
instead — see `createEngineManager` in the API surface below.

### Lower level — direct argv

```ts
import { createEngine } from '@typeward/texlive-wasm';

const engine = await createEngine('xelatex', {
  enginePath: '/texlive-wasm/xelatex/emscripten/xelatex.wasm',
  cdnBaseUrl: 'https://cdn.jsdelivr.net/npm/texlive-wasm-tlod@2026/dist/',
});

const r = await engine.run({
  args: ['-interaction=nonstopmode', '-halt-on-error', 'doc.tex'],
  files: [{ path: 'doc.tex', content }],
});
await engine.dispose();
```

## Tauri

`texlive-wasm/tauri` adds a `TauriFS` VFS backend that reads bundled
TeX Live resources directly from disk (no OPFS copy, no per-file fetch
overhead):

```ts
import { createEngine } from '@typeward/texlive-wasm';
import { withTauriFs, isTauri } from '@typeward/texlive-wasm/tauri';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

const engine = await withTauriFs(
  (vfs) =>
    createEngine('xelatex', {
      vfs,
      enginePath: '/texlive-wasm/xelatex/emscripten/xelatex.wasm',
    }),
  { texmfRoot: 'texlive-wasm/texmf', baseDir: BaseDirectory.Resource },
);
```

A working SolidJS + Tauri 2.0 app is in [`examples/tauri/`](./examples/tauri/):

```bash
npm install
npm --prefix examples/tauri install
npm run tauri:dev
```

The example ships the engine + TDS as Tauri `resources`, so the resulting
installer is fully offline. See [`examples/tauri/README.md`](./examples/tauri/README.md).

## API surface

```ts
import {
  createEngine,            // low-level: createEngine(id, config) → run({ args, files })
  PdfLatex,
  XeLatex,
  LuaLatex,
  Bibtexu,
  Makeindex,
  Xdvipdfmx,
  latexmk,                 // multi-pass driver
  createSynctex,           // JS parser for .synctex(.gz) — files and source/PDF position lookup
  loadManifest,            // tex-packages.json reader
} from '@typeward/texlive-wasm';

import { withTauriFs, createTauriFs, isTauri } from '@typeward/texlive-wasm/tauri';
```

VFS chain (consulted in order on every read):

1. **BundleFS** — preloaded core TDS in memory.
2. **TauriFS** / **OPFS** — when running under Tauri or a browser PWA.
3. **FETCHFS** — last-resort CDN long-tail fetch.

You can pass a custom chain via `EngineConfig.vfs` to override the
default for tests or unusual deployments.

## Releasing

```bash
# 1. Build the engines (Docker required).
npm run engines:build

# 2. Pack release tarballs from engine-artifacts/.
npm run release:pack            # → release/*.tar.gz + checksums.json

# 3. Tag and push; .github/workflows/release.yml uploads the archives.
git tag v0.1.0-alpha.1
git push --tags
```

The release workflow is matrix-built per engine, packs via
`scripts/pack-release.mjs`, and attaches everything to the GitHub
Release. The `texlive-wasm` CLI then fetches from
`releases/download/<tag>/<asset>`.

Once the release assets are up, the workflow publishes the wrapper to npm
via [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC — no token secret). A guard step fails the publish if
`package.json` doesn't match the tag, and prereleases land on the `next`
dist-tag per the [version contract](#version-contract).

## Layout

```
src/                  — TypeScript wrapper library (MIT)
  core/               — engine handles, manifest, worker bridge
  engines/            — typed wrappers for each engine
  vfs/                — BundleFS, OPFS, FETCHFS, TauriFS backends
  latexmk/            — multi-pass driver
  synctex/            — JS parser
  tauri.ts            — Tauri entry point
scripts/
  cli.cjs             — `npx @typeward/texlive-wasm`
  pack-release.mjs    — bundle engine-artifacts/ into release/*.tar.gz
  ensure-assets.mjs   — used by examples
demo/                 — Vite + SolidJS showcase site (deployed to GitHub Pages)
examples/tauri/       — Tauri 2.0 + SolidJS example
engine/               — Docker-based engine build (Emscripten + wasi-sdk)
plan.md               — design notes & roadmap
```

## License

MIT for the wrapper code in `src/` and the CLI. Engine artifacts inherit
their upstream TeX Live licenses (LPPL, GPL, and friends) — see the
TeX Live LICENSE.TL bundled with each release.

## Node and release tarballs

This fork publishes an installable `typeward-texlive-wasm-<version>.tgz` with each
GitHub release, alongside the engines, TDS bundles, manifests and SHA-256 checksums.
The npm scope remains `@typeward/texlive-wasm`; publishing this fork does not publish
to that npm scope. Download the matching wrapper tarball and install it locally:

```sh
npm install ./typeward-texlive-wasm-0.3.1-alpha.tgz
npx texlive-wasm download-assets
```

Node uses worker threads so timeouts and cancellation can terminate a synchronous
engine. It supports HTTP assets and explicit local paths/file URLs:

```ts
import { createEngine, latexmk } from '@typeward/texlive-wasm';

const handle = await createEngine('pdflatex', {
  enginePath: './public/texlive-wasm/pdflatex/emscripten/pdflatex.wasm',
  manifestUrl: './public/texlive-wasm/tex-packages-pdflatex.json',
});
try {
  const result = await latexmk({
    engine: 'pdflatex', mainTex: 'main.tex',
    files: [{path: 'main.tex', content: String.raw`\documentclass{article}\begin{document}Hello\end{document}`}],
    handles: {tex: handle}, timeoutMs: 60_000,
  });
  console.log(result.success, result.converged, result.maxPassesReached);
} finally {
  await handle.dispose();
}
```

`latexmk` reports failure when its automatic pass budget is exhausted with a rerun
still pending, while retaining the PDF for preview. Explicit `rerun: false` keeps
single-pass success semantics; `converged` still reports unresolved work.

`initTimeoutMs` (default 300000; 0 disables) and `initSignal` bound engine startup.
Wrapper invocation deadlines include startup; queued low-level calls can be
cancelled without terminating another caller's active run. `fmtPath` downloads
an explicit format, and low-level `stdin` accepts UTF-8 strings or bytes.
`lazyFetch` retries up to eight rounds by default, within the invocation deadline.

Verified cache/CDN layers reject files missing from the manifest. Explicit custom
backends can still provide application-owned files. OPFS is optional and falls back
when unavailable; core bundles remain usable in those contexts. Engine managers
recreate terminated workers and trim excess idle workers after multi-engine scopes.

## Verification and reproducible assets

```sh
npm ci
npm run check
npx playwright install --with-deps chromium firefox webkit
npm run test:browser
bash rust/build-wasm.sh  # requires the wasm-bindgen CLI version in rust/Cargo.lock
node rust/wasm-smoke.mjs
node test/rust-parity.mjs
```

Coverage gates: 85% statements, 75% branches, 85% functions and 85% lines. Browser
integration exercises workers, Comlink, transferred outputs, cancellation/recovery
and OPFS persistence or fallback on Chromium, Firefox and WebKit, including mobile
viewport profiles. Those profiles do not replace testing on physical Android/iOS devices.
The transport fixtures deliberately do not pretend to be TeX engines. Release
smoke tests compile real documents against the freshly built engines separately.

TDS assembly pins the Ubuntu image by digest and the TeX/font package versions in
`scripts/data/tds-packages.lock`. It stages a complete tree before publishing it,
checks the installed package set and records a completion marker tied to the lock.
An optional `TDS_SNAPSHOT=YYYYMMDDTHHMMSSZ` selects Ubuntu's snapshot service when
available. All shipped formats are subsequently regenerated with the matching WASM
engine. The runtime TDS is assembled from Ubuntu's TeX packages; the engine sources
come from the pinned TeX Live submodule, so these are distinct provenance/version layers.

The Rust crate is an optional host-independent core, tested natively and via its
WASM bindings. It is not an additional mandatory download for the TypeScript API.
Shared detection fixtures enforce parity for bibliography/index routing. Runtime
orchestration and full SyncTeX position lookup currently live in TypeScript.

### Content diagnostics, incremental edits and language packs

In 0.4+, `latexmk({ strict: true, ... })` fails on missing glyphs, missing
index/glossary outputs and unresolved content. Inspect `result.complete` and
`result.diagnostics` in addition to the PDF. `createCompileSession` reuses workers
and validated auxiliary state across edits, including the XeLaTeX converter.
Optional integrity-pinned Portuguese/ABNT and multilingual Noto packs extend the
TDS without enlarging the core for every app.

See [0.4 integration and validation](docs/validation-0.4.0-alpha.md) for setup,
cache invalidation, resource profiles and explicit host-tool integrations.

### Optional project features in 0.5

Exact-family font packs, verified on-demand TeX packages, project preflight, progress/previews, isolated partial builds, warmup, content-addressed worker inputs and SyncTeX phrase refinement are available as optional APIs. See the [integration guide](docs/features-0.5.0.md) and [development plan](docs/development-0.5.0.md).
