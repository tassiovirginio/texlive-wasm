//! texlive-wasm — Rust core of the TeX Live → WebAssembly wrapper.
//!
//! This crate ports the JavaScript/TypeScript wrapper (`src/`) of
//! `@typeward/texlive-wasm` to Rust. It compiles:
//!
//! * as a native `rlib` for unit tests and reuse, and
//! * as a `cdylib` for `wasm32-unknown-unknown`, exposing the same helpers to
//!   JavaScript through `wasm-bindgen` (enable the `wasm` feature).
//!
//! What lives here is the *host-independent* logic the TS wrapper used to
//! carry: path confinement, the `tex-packages.json` manifest, ls-R rendering,
//! kpathsea path mapping, tar parsing + bundle decompression, engine argv
//! builders, and latexmk's multi-pass detection heuristics. The engine
//! `.wasm` files themselves (Emscripten builds of TeX Live) are unchanged
//! artifacts fetched at runtime — this crate does not reimplement TeX.
//!
//! The Web Worker / Comlink bridge and the Emscripten `FS`/`callMain` glue
//! stay on the JS side; [`wasm`] hands JS the pure functions it orchestrates.

pub mod core;
pub mod engines;
pub mod latexmk;
pub mod synctex;
pub mod vfs;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub mod wasm;

pub use core::manifest::{ManifestEntry, ManifestTier, TexPackagesManifest};
pub use core::paths::{safe_relative_path, safe_resolve};
pub use core::types::{EngineId, FileInput};
