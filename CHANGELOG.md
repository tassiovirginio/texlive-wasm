# Changelog

## 0.4.0-alpha

- Add structured content diagnostics, strict compilation and byte-exact convergence across chapter auxiliaries, contents, bookmarks and navigation; detect oscillating states.
- Compile named indexes, makeindex glossaries and acronym lists, and prevent stale helper outputs from reappearing.
- Add incremental project sessions with worker/helper reuse, conservative invalidation and shared initialization/compilation deadlines; use strict sessions in the showcase.
- Cache filesystem mounting plans and filename databases, overlap startup downloads, deduplicate lazy-fetch attempts and preserve fontconfig caches.
- Invalidate font caches when project fonts change, expose real libc environment overrides and reject ICU initialization errors.
- Regenerate the DVI LaTeX format, remove its unused copy from the pdfLaTeX core, and include Latin Modern/EC support needed by common fontenc documents.
- Preload Portuguese hyphenation and publish integrity-pinned Portuguese/ABNT and Unicode Noto/Arabic/CJK resource packs with required ABNT dependencies.
- Retain contributed bibliography styles in full TDS and publish explicit engine/package compatibility metadata.
- Add cancellable host-tool phases for converters, highlighting, auxiliary tools and PDF validation without shell escape.
- Add real-engine content and native-PDF fidelity gates, session benchmarks and application migration documentation.

## 0.3.1-alpha

- Pin CI to Ubuntu 24.04 so browser dependencies remain compatible with the validated Playwright version.
- Preserve the previously published 0.3.0-alpha tag and ship the corrected CI contract in a patch release.

## 0.3.0-alpha

- Run Emscripten engines in Node worker threads, including local assets, ES/CJS transport, deadlines and cancellation.
- Recover terminated engine-manager workers, preserve VFS priority, and release excess workers after multi-engine scopes.
- Share the library manager with the demo and report pipeline convergence/pass-cap exhaustion.
- Ignore commented/non-source bibliography markers and rerun BibTeX when auxiliary state changes.
- Implement SyncTeX position queries, coordinate transforms, compressed positions and PDF form placements.
- Support explicit format downloads, stdin and custom working-directory logs.
- Bound streamed downloads, validate manifests and reject unknown files in verified cache/CDN layers.
- Harden CLI extraction against escaping paths, existing symlinks, corrupt archives and decompression limits.
- Pin TDS package/image inputs, verify completion and publish per-engine integrity manifests.
- Add an optional Rust core with native/WASM checks and shared TypeScript parity fixtures.
- Upgrade development dependencies, enforce coverage thresholds, and exercise browser/Node integrations and both frontends in CI.
- Attach an installable wrapper tarball to GitHub releases, including forks without npm publishing.
