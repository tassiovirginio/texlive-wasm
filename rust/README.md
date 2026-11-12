# texlive-wasm — Rust core (wasm32)

A Rust port of the `@typeward/texlive-wasm` TypeScript wrapper, compiling to
WebAssembly (`wasm32-unknown-unknown`) via [`wasm-bindgen`](https://wasm-bindgen.github.io/).

This crate contains the **host-independent logic** the TS wrapper used to carry
in `../src/`. The engine artifacts themselves — the Emscripten builds of
pdfLaTeX, XeLaTeX, LuaLaTeX, BibTeXu, biber, makeindex, xdvipdfmx — are **not**
reimplemented here. They stay external `.wasm` files fetched at runtime, exactly
as before. The Web Worker / Comlink bridge and the Emscripten `FS`/`callMain`
glue also stay on the JS side; this crate hands JS the pure functions it
orchestrates.

## Layout

```
src/
  core/
    types.rs      EngineId, FileInput, VfsTier, RunResult
    paths.rs      safeRelativePath / safeResolve (path confinement)
    manifest.rs   tex-packages.json parsing, tiers, sha256, integrity
    lsr.rs        kpathsea ls-R rendering
    kpse.rs       TDS ↔ mounted-absolute path mapping
    missing.rs    missing-file log parsing + name expansion
  vfs/
    tar.rs        ustar parsing, gzip/deflate-raw decompression, bomb caps
    bundlefs.rs   bundle format detection + validated unpacking
  engines/
    mod.rs        per-engine argv builders (typed, serde-deserialized)
  latexmk/
    mod.rs        multi-pass heuristics: bibtex/biber/makeindex, rerun, passes
  synctex/
    mod.rs        .synctex(.gz) parsing → input-file list
  wasm.rs         wasm-bindgen surface (gated behind the `wasm` feature)
```

What is **not** ported, and why:

- **Web Worker / Comlink RPC** — host I/O and structured cloning.
- **Emscripten `FS` mounting and `callMain`** — engine-runtime specific.
- **Fetch / OPFS / Tauri VFS backends** — filesystem access is a host concern;
  the Rust core exposes the tar/decompression and path primitives they build on.
- **`latexmk()`'s multi-pass loop** — it drives engine handles; the Rust core
  provides every decision it makes (which helper to run, how many passes,
  whether the log asks for a rerun).
- **The CLI and the SolidJS demo** — out of scope for the core crate.

## Build

Prerequisites:

```sh
rustup target add wasm32-unknown-unknown
# match the wasm-bindgen version pinned in Cargo.lock:
cargo install wasm-bindgen-cli --version 0.2.129 --locked
```

Then:

```sh
./build-wasm.sh              # release build → ./pkg (JS + .d.ts + .wasm)
PROFILE=debug ./build-wasm.sh
```

`wasm-opt` (binaryen) is optional; the release profile already sets
`opt-level = "s"`, `lto = true`, and `strip = true`.

## Native use and tests

The crate is a normal `rlib` too — the `wasm-bindgen` bindings are compiled only
for `wasm32` when the `wasm` feature is on, so everything below works on the
host:

```sh
cargo test --locked # native unit tests
cargo build         # native rlib
```

Verification of the real bindings (after `./build-wasm.sh`):

```sh
node wasm-smoke.mjs      # loads ./pkg, instantiates, exercises the JS API
```

## JavaScript API

`./build-wasm.sh` emits `pkg/texlive_wasm.js` (+ `.d.ts`) exporting:

| Export | Notes |
| --- | --- |
| `safeRelativePath(path)` | `string \| undefined` — `undefined` when unsafe |
| `safeResolve(root, path)` | confined join; rejects `..` and sibling-prefix roots |
| `buildLsR(paths)` | ls-R database text |
| `tdsRelative(abs)` / `tdsAbsolute(rel, mount?)` | TDS path mapping |
| `parseMissingFiles(log)` / `expandMissingName(name)` | missing-file detection |
| `Manifest.fromJson(json)` | parsed manifest with `tierOf`, `packageOf`, `expectedSha256`, `fileCount`, `version` |
| `sha256Hex(bytes)` | lowercase hex digest |
| `untar(bytes, maxEntries?)` | `[{ path, type, content: Uint8Array }]` |
| `detectBundleFormat(url, bytes)` / `decompress(bytes, format, maxBytes?)` / `unpackBundleTar(tar, stripPrefix?)` / `loadBundle(bytes, url, optsJson)` | bundle handling |
| `willRunBibtex(filesJson)` / `willRunBiber(filesJson)` / `detectMakeindex(filesJson)` | `filesJson` = `[{path, content}]` |
| `rerunRequested(log)` / `maxPasses(modeJson, biblatexMode)` | rerun policy |
| `projectPaths(mainTex)` | `{ base, aux, bcf, idx, xdv, pdf, log, synctex }` |
| `engineArgs(engine, optionsJson)` | argv for one engine |
| `synctexInputFiles(bytes)` | input-file list from `.synctex`/`.synctex.gz` |

Everything that returns a collection of mixed values takes **JSON strings** in
and out where a JS caller would otherwise need a `wasm-bindgen` struct per type
(`filesJson`, `optionsJson`, `optsJson`, `modeJson`); simple scalars and
`Uint8Array` are passed natively.

## Decompression

`decompress()` handles **gzip** and **deflate-raw** in Rust (via `flate2`'s
pure-Rust `miniz_oxide` backend, so it works without a C toolchain on
`wasm32-unknown-unknown`). **Brotli** is intentionally *not* built into the Rust
core: the crate returns a clear error, and the host's
`DecompressionStream('br')` handles that format. This mirrors the TS wrapper,
which deferred to the browser.

## Relationship to `../src`

This is a faithful port, not a redesign. Behaviour that tests pin down —
path-confinement edge cases, tar size/entry caps, bundle integrity rules, the
biblatex `backend=bibtex` → bibtexu routing, biber-vs-bibtex detection — is
preserved. Where the TS had a small helper inline, the Rust keeps it a named
function with a unit test. The MIT licence applies to this crate; engine
artifacts inherit their TeX Live licences.

The TypeScript runtime remains the default. CI builds this optional core, tests
its native API and wasm-bindgen surface, and compares source-detection behavior
with the TypeScript implementation using shared fixtures. Unknown manifest files
are rejected by verified integrity checks. The build script checks the CLI/lockfile
version before compiling and supports `PROFILE=debug` as well as `release`.
