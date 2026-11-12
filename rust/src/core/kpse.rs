//! kpathsea (`kpse`) path resolution helpers — port of `src/core/kpse.ts`.
//!
//! The C-level kpse linked into the engine still does the canonical work; this
//! is only the JS-side normalization used when a backend read is asked for an
//! absolute `/texmf-dist/...` path.

/// Strip a leading `/texmf-dist/` (or similar TEXMF root) prefix and return the
/// TDS-relative path. Returns `None` if the path doesn't look like a TEXMF read.
pub fn tds_relative(abs_path: &str) -> Option<String> {
    const ROOTS: [&str; 3] = ["/texmf-dist/", "/texlive/texmf-dist/", "/texmf/"];
    for root in ROOTS {
        if let Some(rest) = abs_path.strip_prefix(root) {
            return Some(rest.to_string());
        }
    }
    None
}

/// Reverse: a TDS-relative path back to an absolute mount point path.
pub fn tds_absolute(rel: &str, mount: &str) -> String {
    format!("{mount}/{}", rel.trim_start_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_known_roots() {
        assert_eq!(
            tds_relative("/texmf-dist/tex/latex/base/article.cls").as_deref(),
            Some("tex/latex/base/article.cls")
        );
        assert_eq!(
            tds_relative("/texlive/texmf-dist/web2c/texmf.cnf").as_deref(),
            Some("web2c/texmf.cnf")
        );
        assert_eq!(tds_relative("/project/main.tex"), None);
    }

    #[test]
    fn re_absolutizes() {
        assert_eq!(
            tds_absolute("tex/latex/base/article.cls", "/texmf-dist"),
            "/texmf-dist/tex/latex/base/article.cls"
        );
    }
}
