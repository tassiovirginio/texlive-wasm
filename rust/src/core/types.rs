//! Shared type definitions — the Rust counterpart of `src/core/types.ts`.
//!
//! Only the parts that are decided on the host side (rather than inside the
//! Web Worker / Comlink bridge) are modelled here: engine ids, file inputs and
//! the shape of a run result.

use std::borrow::Cow;
use std::collections::BTreeMap;

/// The engine artifacts the project builds, one `.wasm` per engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EngineId {
    PdfLatex,
    XeLatex,
    LuaLatex,
    Bibtexu,
    Xdvipdfmx,
    Makeindex,
    Biber,
}

impl EngineId {
    /// The lowercase identifier used in URLs and on the command line.
    pub fn as_str(self) -> &'static str {
        match self {
            EngineId::PdfLatex => "pdflatex",
            EngineId::XeLatex => "xelatex",
            EngineId::LuaLatex => "lualatex",
            EngineId::Bibtexu => "bibtexu",
            EngineId::Xdvipdfmx => "xdvipdfmx",
            EngineId::Makeindex => "makeindex",
            EngineId::Biber => "biber",
        }
    }

    pub fn parse(s: &str) -> Option<EngineId> {
        Some(match s {
            "pdflatex" => EngineId::PdfLatex,
            "xelatex" => EngineId::XeLatex,
            "lualatex" => EngineId::LuaLatex,
            "bibtexu" => EngineId::Bibtexu,
            "xdvipdfmx" => EngineId::Xdvipdfmx,
            "makeindex" => EngineId::Makeindex,
            "biber" => EngineId::Biber,
            _ => return None,
        })
    }

    /// Engines that speak web2c/kpathsea argv conventions (`-fmt`, `-cnf-line`).
    pub fn is_tex(self) -> bool {
        matches!(
            self,
            EngineId::PdfLatex | EngineId::XeLatex | EngineId::LuaLatex
        )
    }
}

impl std::fmt::Display for EngineId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A file dropped into `/project` before the engine starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInput {
    pub path: String,
    pub content: Vec<u8>,
}

impl FileInput {
    pub fn text(path: impl Into<String>, content: impl Into<String>) -> Self {
        FileInput {
            path: path.into(),
            content: content.into().into_bytes(),
        }
    }

    pub fn bytes(path: impl Into<String>, content: impl Into<Vec<u8>>) -> Self {
        FileInput {
            path: path.into(),
            content: content.into(),
        }
    }

    /// Interprets the bytes as UTF-8 (lossy), matching the TS `TextDecoder`
    /// with `fatal: false` used by latexmk's source inspection.
    pub fn content_str(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.content)
    }
}

/// Which delivery tier a manifest entry belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VfsTier {
    Core,
    Full,
    Cdn,
}

/// The files the engine PRODUCED under `/project`, keyed by path.
#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub outputs: BTreeMap<String, Vec<u8>>,
    pub log: String,
    pub duration_ms: f64,
    pub lazy_fetch_retries: Option<u32>,
    pub lazy_tds: Option<bool>,
}
