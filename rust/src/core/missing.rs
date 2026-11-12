//! Missing-file detection and TDS location guessing.
//!
//! Rust port of the `parseMissingFiles` / `expandMissingName` helpers at the
//! bottom of `src/core/worker.ts`. These back the on-miss lazy fetch: after a
//! failed pass the worker parses the log for the files TeX could not find,
//! resolves them through the VFS chain and retries once.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid regex")
}

struct Pattern {
    re: Regex,
    capture: usize,
}

static MISSING_PATTERNS: LazyLock<Vec<Pattern>> = LazyLock::new(|| {
    let specs: [(&str, usize); 9] = [
        // TeX engines.
        (r"I can't find file `([^']+)'", 1),
        (r"File `([^']+)' not found", 1),
        (r"file `([^']+)' is not loadable", 1),
        (
            r"(?i)Cannot find ([\w.-]+\.(?:sty|cls|fd|def|cfg|tfm|vf|pfb|otf|ttf|mf|enc|map))",
            1,
        ),
        // bibtex/bibtexu (.blg): "I couldn't open style file plainnat.bst".
        (
            r"I couldn't open (?:style|database|auxiliary) file ([\w./-]+)",
            1,
        ),
        // makeindex (.ilg): "Index style file custom.ist not found".
        (r"[Ii]ndex style file ([\w./-]+) not found", 1),
        (r"Couldn't (?:open|find) (?:style|input) file ([\w./-]+)", 1),
        // xdvipdfmx / dvipdfmx (stderr): missing CMaps, font maps, encodings.
        (
            r#"Could not open (?:file|font|CMap)[:\s]+"?([\w./-]+)"?"#,
            1,
        ),
        (r#"Unable to find (?:file|font)[:\s]+"?([\w./-]+)"?"#, 1),
    ];
    specs
        .into_iter()
        .map(|(p, capture)| Pattern { re: re(p), capture })
        .collect()
});

/// Pull "I can't find file `x.sty'" / "Font ... not found" / "! LaTeX Error:
/// File `x.sty' not found" lines out of the log and return the referenced
/// filenames (deduplicated, in first-seen order).
pub fn parse_missing_files(log: &str) -> Vec<String> {
    if log.is_empty() {
        return Vec::new();
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<String> = Vec::new();
    for pattern in MISSING_PATTERNS.iter() {
        for caps in pattern.re.captures_iter(log) {
            let name = caps
                .get(pattern.capture)
                .map(|m| m.as_str().trim())
                .unwrap_or("");
            if name.is_empty() || name.contains("//") || name.starts_with('-') {
                continue;
            }
            if seen.insert(name.to_string()) {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// Given a bare file name like "amsmath.sty", produce the candidate TDS
/// subpaths a backend might serve it under, in the order they should be tried.
pub fn expand_missing_name(name: &str) -> Vec<String> {
    if name.starts_with('/') || name.contains('/') {
        return vec![name.to_string()];
    }
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let stem = name;
    let mut out = vec![stem.to_string()];

    let strip_ext = |s: &str| -> String {
        match s.rsplit_once('.') {
            Some((head, _)) if !head.is_empty() => head.to_string(),
            _ => s.to_string(),
        }
    };
    // Matches TS `stem.replace(/\d.*$/, '')` — drop from the first ASCII digit.
    let drop_digits = |s: &str| -> String {
        match s.find(|c: char| c.is_ascii_digit()) {
            Some(i) => s[..i].to_string(),
            None => s.to_string(),
        }
    };

    match ext.as_str() {
        "sty" | "cls" | "def" | "fd" | "cfg" => {
            out.push(format!("tex/latex/{}/{}", strip_ext(stem), stem));
            out.push(format!("tex/latex/base/{stem}"));
        }
        "tex" | "ltx" => {
            out.push(format!("tex/generic/{}/{}", strip_ext(stem), stem));
        }
        "tfm" => {
            out.push(format!("fonts/tfm/public/{}/{}", strip_ext(stem), stem));
        }
        "otf" | "ttf" => {
            out.push(format!(
                "fonts/opentype/public/{}/{}",
                drop_digits(stem),
                stem
            ));
            out.push(format!(
                "fonts/truetype/public/{}/{}",
                drop_digits(stem),
                stem
            ));
        }
        "pfb" | "pfa" => {
            out.push(format!("fonts/type1/public/{}/{}", drop_digits(stem), stem));
        }
        "map" | "enc" => {
            out.push(format!("fonts/{ext}/dvips/{}/{}", strip_ext(stem), stem));
        }
        "bst" => {
            // bibtexu's styles: TDS puts them under bibtex/bst/<package>/.
            out.push(format!("bibtex/bst/{}/{}", strip_ext(stem), stem));
            out.push("bibtex/bst/base/".to_string() + stem);
        }
        "bib" => {
            out.push(format!("bibtex/bib/{}/{}", strip_ext(stem), stem));
        }
        "ist" | "mst" => {
            out.push(format!("makeindex/{}/{}", strip_ext(stem), stem));
            out.push("makeindex/base/".to_string() + stem);
        }
        // xdvipdfmx CMaps have no extension ("UniJIS-UCS2-H").
        "" | "cmap" => {
            out.push(format!("fonts/cmap/{stem}"));
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tex_missing_file() {
        let log = "! LaTeX Error: File `geometry.sty' not found.\nI can't find file `foo.tex'.";
        let missing = parse_missing_files(log);
        assert!(missing.contains(&"geometry.sty".to_string()), "{missing:?}");
        assert!(missing.contains(&"foo.tex".to_string()), "{missing:?}");
    }

    #[test]
    fn parses_helper_dialects() {
        assert_eq!(
            parse_missing_files("I couldn't open style file plainnat.bst"),
            vec!["plainnat.bst"]
        );
        assert_eq!(
            parse_missing_files("Index style file custom.ist not found"),
            vec!["custom.ist"]
        );
        assert_eq!(
            parse_missing_files("Unable to find font: lmroman10-regular.otf"),
            vec!["lmroman10-regular.otf"]
        );
    }

    #[test]
    fn ignores_junk() {
        assert!(parse_missing_files("").is_empty());
        assert!(parse_missing_files("Could not open file: //double").is_empty());
    }

    #[test]
    fn expands_sty() {
        let out = expand_missing_name("amsmath.sty");
        assert_eq!(out[0], "amsmath.sty");
        assert!(
            out.contains(&"tex/latex/amsmath/amsmath.sty".to_string()),
            "{out:?}"
        );
        assert!(
            out.contains(&"tex/latex/base/amsmath.sty".to_string()),
            "{out:?}"
        );
    }

    #[test]
    fn expands_otf_drops_digits() {
        let out = expand_missing_name("lmroman10-regular.otf");
        assert!(out.contains(&"fonts/opentype/public/lmroman/lmroman10-regular.otf".to_string()));
    }

    #[test]
    fn bare_and_slashed_names_are_verbatim() {
        assert_eq!(expand_missing_name("/abs/path.sty"), vec!["/abs/path.sty"]);
        assert_eq!(expand_missing_name("tex/a.sty"), vec!["tex/a.sty"]);
    }
}
