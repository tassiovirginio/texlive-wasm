# texlive-wasm

A from-scratch TeX Live → WebAssembly distribution. Goal: a modular npm package that compiles LaTeX in the browser (and on the edge/server via WASI) with a smaller initial load, cleaner VFS, and a better DX than the current state of the art.

Status: **Phase 0 complete, Phase 1 mostly complete (TL 2026).** TS library + CI verified green. Engines built against **TeX Live 2026** (`branch2026`, commit `fb61589266` "tl26 post-release"):

| Engine | Size | Smoke test (TL 2026) |
|---|---|---|
| `pdflatex.wasm` | 1.26 MB | ✅ "pdfTeX 3.141592653-2.6-1.40.29" — **compiles real `\documentclass{article}` → PDF (2.4 KB)** |
| `xelatex.wasm` | 2.84 MB | ✅ "XeTeX 3.141592653-2.6-0.999998, ICU 78.2" |
| `lualatex.wasm` | 4.84 MB | ✅ "LuaHBTeX 1.24.0" |
| `bibtexu.wasm` | 877 KB | ✅ "BibTeXu 0.99d-x4.03, ICU 78.2" |
| `xdvipdfmx.wasm` | 765 KB | ✅ instantiates |
| `makeindex.wasm` | 192 KB | ✅ instantiates |
| `biber.wasm` | 9.1 MB (+14 MB VFS) | ✅ "biber version: 2.19" — .bbl byte-identical to native (Perl 5.42 on wasm) |
| `synctex.wasm` | — | Deferred: synctex is built into each engine, JS parser at `src/synctex/index.ts` suffices |

End-to-end smoke test verified (`scripts/smoke-pdflatex.mjs`): `\documentclass{article}\begin{document}Hello\end{document}` → valid PDF 1.5 (2387 bytes) using our wasm pdflatex + a minimal TeX Live TDS (sourced via `scripts/fetch-tds.sh`).

For xelatex + bibtexu: requires wasm builds of expat 2.6.4, freetype 2.13.3, fontconfig 2.15.0 (built standalone in `engine/build/wasm-libs/` via `engine/targets/fontconfig-wasm.mk`), the standalone native ICU pre-build (`engine/targets/icu-native.mk`), and a placeholder `icudt78_dat` stub in `engine/scripts/stubs.c` (locale-data ICU APIs return U_MISSING_RESOURCE_ERROR; basic engine startup + non-locale-specific operations work).

Engine artifacts staged in `engine-artifacts/<engine>/emscripten/`. The pipeline (`engine/Dockerfile` + `engine/Makefile` + helpers + native ICU pre-build + force-include stubs) is reproducible — once Docker is available, `npm run engines:build` rebuilds them from source.

See `plan.md` Phase 1 for design and the remaining ICU-data + fontconfig work.

## Layout

- `example/busytex/` — Reference: the original busytex (TL 2023, MIT). Emscripten + musl single-binary, custom packfs, Emscripten `.data`+`.js` preloaded packages, JS pipeline that drives xelatex/bibtex8/xdvipdfmx in sequence. Study `Makefile`, `busytex.c`, `packfs.c`, `busytex_pipeline.js`.
- `example/texlyre-busytex/` — Reference: TS wrapper around a TL 2026 rebuild of busytex (AGPL-3). Adds Web Worker bridge, per-engine builds, on-demand TLOD endpoint, IndexedDB cache via Emscripten `EM_PRELOAD_CACHE`. Study `src/core/busytex-runner.ts`, `src/core/package-cache.ts`.
- `plan.md` — design + roadmap for the new implementation.
- `src/` — TS wrapper library; `engine/` — Docker engine build; `scripts/` — asset/build/smoke scripts; `vendor/texlive-source/` — TL submodule (branch2026); `demo/` — SolidJS web demo; `examples/tauri/` — Tauri 2.0 example.

## Locked decisions (see plan.md §9)

- **Engines v1:** pdflatex, xelatex, lualatex (all three at once) + bibtexu, xdvipdfmx, makeindex, synctex. One `.wasm` per engine — `wasm-ld --localize-hidden` (LLVM #50623) is still unimplemented in 2026.
- **Primary target:** Tauri 2.0 + SolidJS + Vite mobile app (Android + iOS), offline-first. Web/PWA is a secondary target.
- **License:** MIT for the wrapper; engine artifacts inherit TL licenses.
- **TL source:** Hard fork of `TeX-Live/texlive-source`, aggressively stripped for mobile (no Perl tools, no MetaPost, no mf-nowin, no docs/man).
- **Toolchain:** Emscripten 5.0.7 (browser/Tauri WebView) and wasi-sdk 33 (Node/edge) from the same C sources. See `engine/Dockerfile` for the exact pins.
- **VFS:** WASMFS with pluggable backends — BundleFS (preloaded core ~20 MB) → TauriFS *or* OPFS (full ~120 MB) → FETCHFS (CDN long tail). Drop the custom packfs C wrap entirely.
- **Asset delivery:** Tiered. Core bundle in npm package; full bundle downloadable or shipped as Tauri resource; CDN is the long-tail fallback.
- **RPC:** Comlink over Web Workers. One worker per engine instance.
- **PDF viewer:** pdf.js in the demo. Document PDFium-WASM for apps wanting peak speed.
- **Threading:** engines ship **single-threaded** (since v0.2.0-alpha). Android System WebView
  cannot reliably provide crossOriginIsolated, and nothing in the engines spawns threads —
  so no SharedArrayBuffer, no COOP/COEP, no coi-serviceworker. `ENABLE_THREADS=1` stays as
  an opt-in make knob; CI pins `ENABLE_THREADS=0` and fails on `shared:true` in the glue.
- **Bibliography (supersedes "Biber: Not shipped"):** the full stack ships. Classic bibtex
  via bibtexu; biblatex via `backend=bibtex` (auto-detected, bibtexu `--wolfgang`); CSL
  styles in-engine under lualatex (citeproc-lua); and **real biber** — Perl 5.42 + biber
  2.19 compiled to wasm (`biber.wasm` 9.1 MB + `biber-vfs.tar.gz` 14 MB, built by
  `make biber-emscripten` / `engine/scripts/biber/spike-build.sh`), output verified
  byte-identical to native. latexmk auto-detects default-backend biblatex docs
  (`willRunBiber`). The biber version is LOCKSTEPPED to the TDS biblatex version —
  `scripts/check-biber-lockstep.mjs` enforces the pairing in CI (biblatex 3.19 ↔ biber 2.19).
- **Do not** copy code from texlyre-busytex (AGPL-3) or vendor SwiftLaTeX directly (AGPL-3).

## Working in this repo

- Treat `example/` as read-only reference material — never edit those trees. Reading `example/busytex/Makefile` for the TL build is fine and recommended; that Makefile inspired our `emcc_wrapper.py` + native pre-build approach.
- The wrapper library (TS, in `src/`) builds clean: `npm install && npm run typecheck && npm test && npm run build`.
- Engine builds run **inside the Docker image** — always:
  ```
  sg docker -c "docker run --rm --user $(id -u):$(id -g) -v $PWD:/workspace -w /workspace/engine -e HOME=/tmp texlive-wasm-builder:dev bash -lc 'make <target>'"
  ```
  The image is built with `sg docker -c "docker build -t texlive-wasm-builder:dev engine/"`.
- Engine targets: `make pdflatex-emscripten`, `make xelatex-emscripten`, etc. The native helper pre-build (`make native-helpers`) is invoked automatically.
- For runtime docker access without re-login after adding the user to the docker group, use `sg docker -c "..."` to spawn a sub-shell with the docker group active.
- Don't add emojis to files unless asked.
- Conventional commits style; commit message focuses on the why.

## Pointers

- TeX Live source: github.com/TeX-Live/texlive-source
- Emscripten WASMFS docs: https://emscripten.org/docs/api_reference/Filesystem-API.html
- wasi-sdk releases: https://github.com/WebAssembly/wasi-sdk/releases
- Tectonic (watch for WASM port): https://github.com/tectonic-typesetting/tectonic/issues/166
- LuaMetaTeX (candidate v2 engine): https://github.com/contextgarden/luametatex

## Regression checks

Every functional change must include meaningful regression tests. Run typecheck,
unit coverage and the relevant integration tests before committing. Coverage gates
live in `vitest.config.ts`; do not lower them to hide regressions. `npm run check`
checks the library and native Rust core; `npm run test:browser` covers browser
workers and storage. Engine changes additionally require the real engine smokes.
Node worker-thread execution is now supported. The WASI target remains experimental.
