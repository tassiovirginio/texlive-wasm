# Changelog

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
