//! latexmk-style driver logic — the source-inspection half.
//!
//! Rust port of `src/latexmk/index.ts`. The multi-pass loop itself is I/O
//! orchestration (it takes engine handles and runs them) and stays on the host
//! side; what lives here is the pure decision-making latexmk needs: which
//! helper engines a document requires, how many passes to allow, and whether a
//! log requests a rerun.

use std::sync::LazyLock;

use regex::Regex;

use crate::core::types::FileInput;

pub const DEFAULT_MAX_PASSES: usize = 4;
// biblatex needs an extra settling pass.
pub const BIBLATEX_MAX_PASSES: usize = 5;

/// How the rerun loop is bounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rerun {
    /// Stop when `.aux` stabilizes and no rerun message appears.
    Auto,
    /// Force a single pass.
    Never,
    /// Cap the loop.
    MaxPasses(usize),
}

/// Resolve the rerun mode with a given biblatex detection result.
pub fn max_passes(rerun: Rerun, biblatex_mode: bool) -> usize {
    match rerun {
        Rerun::Never => 1,
        Rerun::MaxPasses(n) => n.max(1),
        Rerun::Auto => {
            if biblatex_mode {
                BIBLATEX_MAX_PASSES
            } else {
                DEFAULT_MAX_PASSES
            }
        }
    }
}

static RERUN_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"Rerun to get cross-references right",
        r"Rerun to get citations correct",
        r"Label\(s\) may have changed",
        r"No file [^.]+\.toc",
        r"Package rerunfilecheck Warning",
        // biblatex's generic rerun request (settles labels/backrefs late).
        r"Please rerun LaTeX",
        r"Please \(re\)run Biber",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("valid regex"))
    .collect()
});

/// Whether the `.log` asks for another pass.
pub fn rerun_requested(log: &str) -> bool {
    RERUN_PATTERNS.iter().any(|re| re.is_match(log))
}

// Matches \usepackage[opts]{biblatex} / \RequirePackage[opts]{biblatex};
// character classes match newlines, so multi-line option lists work.
static BIBLATEX_LOAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{\s*biblatex\s*\}")
        .expect("valid regex")
});
static BIBLATEX_PASS_OPTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\PassOptionsToPackage\s*\{([^}]*)\}\s*\{\s*biblatex\s*\}").expect("valid regex")
});
static BACKEND_BIBTEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)backend\s*=\s*bibtex8?\s*(?:[,\]}]|$)").expect("valid regex")
});

/// Strip TeX comments, respecting an odd number of escaping backslashes.
pub fn strip_tex_comments(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let bytes = line.as_bytes();
            for (i, b) in bytes.iter().enumerate() {
                if *b != b'%' {
                    continue;
                }
                let mut start = i;
                while start > 0 && bytes[start - 1] == b'\\' {
                    start -= 1;
                }
                if (i - start) % 2 == 0 {
                    return &line[..i];
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn source_text(file: &FileInput) -> String {
    let path = file.path.to_ascii_lowercase();
    if [".tex", ".ltx", ".sty", ".cls"]
        .iter()
        .any(|ext| path.ends_with(ext))
    {
        strip_tex_comments(&file.content_str())
    } else {
        String::new()
    }
}

/// Whether any source loads biblatex.
pub fn uses_biblatex(files: &[FileInput]) -> bool {
    files
        .iter()
        .any(|f| BIBLATEX_LOAD.is_match(&source_text(f)))
}

/// Whether biblatex is loaded with `backend=bibtex` (i.e. route through bibtexu).
pub fn biblatex_backend_is_bibtex(files: &[FileInput]) -> bool {
    files.iter().any(|f| {
        let text = source_text(f);
        if let Some(caps) = BIBLATEX_LOAD.captures(&text) {
            if let Some(opts) = caps.get(1) {
                if BACKEND_BIBTEX.is_match(opts.as_str()) {
                    return true;
                }
            }
        }
        match BIBLATEX_PASS_OPTS.captures(&text) {
            Some(caps) => caps
                .get(1)
                .is_some_and(|g| BACKEND_BIBTEX.is_match(g.as_str())),
            None => false,
        }
    })
}

/// Public preview of latexmk's bibtex auto-detection.
pub fn will_run_bibtex(files: &[FileInput]) -> bool {
    detect_bibtex(files, uses_biblatex(files))
}

/// Same preview for biber: default-backend biblatex documents.
pub fn will_run_biber(files: &[FileInput]) -> bool {
    uses_biblatex(files) && !biblatex_backend_is_bibtex(files)
}

/// Whether bibtexu should run.
pub fn detect_bibtex(files: &[FileInput], biblatex_mode: bool) -> bool {
    // biblatex docs: bibtexu can process the aux only for backend=bibtex
    // setups (biblatex also aliases \bibliography to \addbibresource, so the
    // classic marker alone must NOT trigger bibtexu on a biber-backend doc).
    if biblatex_mode {
        return biblatex_backend_is_bibtex(files);
    }
    // Classic bibtex: `\bibliography{…}` writes the aux bibtexu processes.
    files
        .iter()
        .any(|f| source_text(f).contains("\\bibliography{"))
}

/// Whether makeindex should run.
pub fn detect_makeindex(files: &[FileInput]) -> bool {
    files.iter().any(|f| {
        let text = source_text(f);
        text.contains("\\makeindex") || text.contains("\\printindex")
    })
}

/// The per-project output paths latexmk keys everything by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPaths {
    pub base: String,
    pub aux: String,
    pub bcf: String,
    pub idx: String,
    pub xdv: String,
    pub pdf: String,
    pub log: String,
    pub synctex: String,
}

/// TeX writes all outputs into the cwd under the jobname (= input basename),
/// even when mainTex lives in a subdirectory — key everything by basename.
pub fn project_paths(main_tex: &str) -> ProjectPaths {
    let stem = strip_tex_ext(main_tex);
    let base = stem.rsplit('/').next().unwrap_or(&stem).to_string();
    ProjectPaths {
        aux: format!("{base}.aux"),
        bcf: format!("{base}.bcf"),
        idx: format!("{base}.idx"),
        xdv: format!("{base}.xdv"),
        pdf: format!("{base}.pdf"),
        log: format!("{base}.log"),
        synctex: format!("{base}.synctex.gz"),
        base,
    }
}

/// `/\.tex$/i`
fn strip_tex_ext(path: &str) -> String {
    if path
        .get(path.len().saturating_sub(4)..)
        .is_some_and(|s| s.eq_ignore_ascii_case(".tex"))
    {
        path[..path.len() - 4].to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::FileInput;

    fn f(path: &str, content: &str) -> FileInput {
        FileInput::text(path, content)
    }

    #[test]
    fn classic_bibliography_triggers_bibtex() {
        let files = [f("main.tex", r"\documentclass{article}\bibliography{refs}")];
        assert!(will_run_bibtex(&files));
        assert!(!will_run_biber(&files));
    }

    #[test]
    fn biblatex_biber_backend_is_left_alone() {
        let files = [f(
            "main.tex",
            r"\usepackage[backend=biber]{biblatex}\bibliography{refs}\printbibliography",
        )];
        // \bibliography is a biblatex alias here — must not trigger bibtexu.
        assert!(!will_run_bibtex(&files));
        assert!(will_run_biber(&files));
    }

    #[test]
    fn biblatex_bibtex_backend_uses_bibtexu() {
        let files = [f(
            "main.tex",
            "\\usepackage[style=authoryear,\n  backend=bibtex]{biblatex}\n\\addbibresource{refs.bib}",
        )];
        assert!(will_run_bibtex(&files));
        assert!(!will_run_biber(&files));
    }

    #[test]
    fn biber_only_doc_has_no_bibtex() {
        let files = [f(
            "main.tex",
            r"\usepackage{biblatex}\addbibresource{refs.bib}\printbibliography",
        )];
        // Default biblatex backend is biber: no bibtexu, biber runs.
        assert!(!will_run_bibtex(&files));
        assert!(will_run_biber(&files));
    }

    #[test]
    fn makeindex_detection() {
        assert!(detect_makeindex(&[f("main.tex", r"\makeindex\printindex")]));
        assert!(!detect_makeindex(&[f("main.tex", "plain")]));
    }

    #[test]
    fn detects_markers_in_binary_content() {
        let files = [FileInput::bytes(
            "main.tex",
            b"\\bibliography{refs}".to_vec(),
        )];
        assert!(will_run_bibtex(&files));
    }

    #[test]
    fn rerun_patterns() {
        assert!(rerun_requested("Rerun to get cross-references right"));
        assert!(rerun_requested("Please (re)run Biber"));
        assert!(!rerun_requested("clean"));
    }

    #[test]
    fn max_passes_modes() {
        assert_eq!(max_passes(Rerun::Never, false), 1);
        assert_eq!(max_passes(Rerun::Auto, false), 4);
        assert_eq!(max_passes(Rerun::Auto, true), 5);
        assert_eq!(max_passes(Rerun::MaxPasses(0), false), 1);
        assert_eq!(max_passes(Rerun::MaxPasses(9), false), 9);
    }

    #[test]
    fn paths_use_basename() {
        let p = project_paths("sub/main.tex");
        assert_eq!(p.base, "main");
        assert_eq!(p.pdf, "main.pdf");
        assert_eq!(p.synctex, "main.synctex.gz");
    }
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    #[test]
    fn shared_source_detection_contract() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../test/fixtures/source-detection.json"))
                .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let files = vec![FileInput {
                path: fixture["path"].as_str().unwrap().into(),
                content: fixture["content"].as_str().unwrap().as_bytes().to_vec(),
            }];
            assert_eq!(
                will_run_bibtex(&files),
                fixture["bibtex"].as_bool().unwrap()
            );
            assert_eq!(will_run_biber(&files), fixture["biber"].as_bool().unwrap());
            assert_eq!(
                detect_makeindex(&files),
                fixture["makeindex"].as_bool().unwrap()
            );
        }
    }
    #[test]
    fn unicode_paths_do_not_panic() {
        assert_eq!(project_paths("漢.tex").base, "漢");
        assert_eq!(project_paths("a漢").base, "a漢");
    }
}
