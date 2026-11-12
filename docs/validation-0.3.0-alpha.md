# Validation of 0.3.0-alpha

Validated locally with Node 20.18.0 and Rust 1.99.1. Engines were rebuilt in the
repository's pinned Docker toolchain. No engine artifacts or local metadata caches
are committed to Git.

| Check | Result |
| --- | --- |
| TypeScript typecheck and formatting | Passed |
| TypeScript regression tests | 175 passed |
| TypeScript coverage | 86.06% statements, 77.86% branches, 88.35% functions, 89.13% lines |
| Rust native tests | 53 passed |
| Rebuilt Rust WASM bindings and shared TS parity | Passed |
| Library ES/CJS build and Node worker transport | Passed |
| Demo and Tauri frontend builds | Passed |
| Chromium/Firefox/WebKit integration, including mobile profiles | 15 passed |
| Structural validation of all seven rebuilt engine artifacts | Passed |
| Real engine/bibliography/CSL smoke scenarios | 8 passed |
| Public Node wrapper with pdfLaTeX, XeLaTeX and LuaLaTeX | Passed, including PDF and SyncTeX |
| Installed release tarball, CLI checksums/extraction and a real PDF | Passed |
| npm dependency audits: library, demo and Tauri frontend | No known vulnerabilities after updates |

The engine smoke scenarios cover pdfLaTeX, XeLaTeX, LuaLaTeX, BibTeXu, makeindex,
biblatex with BibTeX, Biber and CSL. XeLaTeX additionally exercises xdvipdfmx.
The Biber/biblatex lockstep check passed (2.19/3.19). LaTeX formats were regenerated
with the corresponding WASM engines, rather than using the incompatible Ubuntu formats.

The browser matrix ran in the official Playwright 1.56.1 Noble container. It
exercises packaged workers, Comlink, output transfer, timeout recovery and OPFS
persistence or fallback. Browser transport fixtures are separate from the real
TeX smoke checks. Physical Android/iOS devices were not available; mobile browser
profiles are not hardware memory validation. The WASI target remains experimental
and is not included in this release.

The public-wrapper smoke records process RSS observations under engine-artifacts/;
these include Node, workers, compiled WASM and garbage not yet collected. They are
not per-engine heap measurements or mobile acceptance thresholds.
