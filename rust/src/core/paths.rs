//! Path confinement for every path that reaches us from outside.
//!
//! Rust port of `src/core/paths.ts`. Caller file inputs, tar entry names and
//! TDS paths parsed out of engine logs are all interpreted relative to a root
//! the engine must not escape (`/project` for inputs, `/texmf-dist` for the
//! tree). A `..` segment — or a tar entry named `/etc/passwd` — would place the
//! write outside that root.

/// Normalize a caller-supplied path to a root-relative one, or return `None`
/// if it tries to escape.
///
/// Leading slashes are stripped (an "absolute" path is taken as relative to
/// the root); `.` segments are dropped; any `..` segment is a rejection rather
/// than something to resolve, since a legitimate TDS or project path never
/// contains one.
pub fn safe_relative_path(path: &str) -> Option<String> {
    let segments: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segments.is_empty() {
        return None;
    }
    if segments.contains(&"..") {
        return None;
    }
    // A Windows drive letter or a UNC-ish leading segment would be nonsense
    // inside the WASM FS; reject rather than silently reinterpret.
    if is_drive_letter(segments[0]) {
        return None;
    }
    // A NUL byte truncates the path at the C boundary: everything after it is
    // invisible to us but not to the engine.
    if segments.iter().any(|s| s.contains('\0')) {
        return None;
    }
    Some(segments.join("/"))
}

/// Resolve a path against an absolute root, or return `None` if it escapes.
/// `root` itself is the identity case — `cwd: '/project'` must stay legal.
pub fn safe_resolve(root: &str, path: &str) -> Option<String> {
    let base = root.trim_end_matches('/');
    // Only a path AT the root or BELOW it is inside it: "/projectile" shares a
    // prefix with "/project" and is not under it.
    let in_root = path == base || path.starts_with(&format!("{base}/"));
    // An absolute path pointing somewhere else entirely is not "relative to
    // the root" — it is an escape spelled without any `..`.
    if !in_root && path.starts_with('/') {
        return None;
    }
    let rest = if in_root { &path[base.len()..] } else { path };
    if rest.is_empty() || rest == "/" {
        return Some(base.to_string());
    }
    safe_relative_path(rest).map(|rel| format!("{base}/{rel}"))
}

/// `/^[a-z]:$/i` — a lone Windows drive component.
fn is_drive_letter(segment: &str) -> bool {
    let b = segment.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(
            safe_relative_path("tex/latex/base/article.cls").as_deref(),
            Some("tex/latex/base/article.cls")
        );
        assert_eq!(
            safe_relative_path("/tex//latex/./base/article.cls").as_deref(),
            Some("tex/latex/base/article.cls")
        );
    }

    #[test]
    fn rejects_traversal() {
        assert_eq!(safe_relative_path("../etc/passwd"), None);
        assert_eq!(safe_relative_path("tex/../../etc/passwd"), None);
        assert_eq!(
            safe_relative_path("/../texmf-dist/web2c/pdftex/pdflatex.fmt"),
            None
        );
        assert_eq!(safe_relative_path("..\\..\\etc\\passwd"), None);
        assert_eq!(safe_relative_path("C:/Windows/system32"), None);
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(safe_relative_path(""), None);
        assert_eq!(safe_relative_path("/"), None);
        assert_eq!(safe_relative_path("."), None);
    }

    #[test]
    fn rejects_nul() {
        assert_eq!(safe_relative_path("main.tex\0../../etc/passwd"), None);
    }

    #[test]
    fn hostile_shapes_never_escape() {
        let hostile = [
            "..",
            "../",
            "./../",
            "a/../../b",
            "//../etc",
            "\\..\\..\\etc",
            "a/./../../..",
            "....//....//etc",
            "/..",
            "C:\\Windows",
            "c:/windows",
        ];
        for path in hostile {
            let safe = safe_relative_path(path);
            if let Some(safe) = safe {
                assert!(!safe.split('/').any(|s| s == ".."), "{path} -> {safe}");
                assert!(!safe.starts_with('/'), "{path} -> {safe}");
            }
        }
    }

    #[test]
    fn resolve_under_root() {
        assert_eq!(
            safe_resolve("/project", "main.tex").as_deref(),
            Some("/project/main.tex")
        );
        assert_eq!(
            safe_resolve("/project", "/project/sub/main.tex").as_deref(),
            Some("/project/sub/main.tex")
        );
        assert_eq!(
            safe_resolve("/project", "/project").as_deref(),
            Some("/project")
        );
        assert_eq!(
            safe_resolve("/project", "/project/").as_deref(),
            Some("/project")
        );
    }

    #[test]
    fn resolve_refuses_escape() {
        assert_eq!(safe_resolve("/project", "/texmf-dist"), None);
        assert_eq!(safe_resolve("/project", "/project/../texmf-dist"), None);
        assert_eq!(safe_resolve("/project", "/"), None);
        assert_eq!(safe_resolve("/project", "/projectile/main.tex"), None);
    }
}
