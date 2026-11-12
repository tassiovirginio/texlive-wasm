//! kpathsea `ls-R` filename-database rendering — port of `src/core/lsr.ts`.
//!
//! The worker regenerates the db from its in-memory TDS map on every fresh
//! engine instance, so `$TEXMFDBS` lookups are always exact — including files
//! added by the lazy-fetch retry after the bundled ls-R was created.

use std::collections::{BTreeMap, BTreeSet};

/// Render an ls-R database for the given TDS-relative file paths. Every
/// directory gets its own `./dir:` block listing files and immediate
/// subdirectories — the shape kpathsea's db parser expects.
pub fn build_ls_r<I, S>(paths: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut by_dir: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for path in paths {
        let path = path.as_ref();
        if path == "ls-R" {
            continue; // the db must not index itself
        }
        let parts: Vec<&str> = path.split('/').collect();
        for i in 0..parts.len() {
            let dir = parts[..i].join("/");
            by_dir.entry(dir).or_default().insert(parts[i].to_string());
        }
    }

    let mut out =
        String::from("% ls-R -- filename database for kpathsea; do not change this line.\n");
    for (dir, names) in &by_dir {
        out.push('\n');
        out.push_str(&format!("./{dir}:"));
        out.push('\n');
        for name in names {
            out.push_str(name);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_per_directory_blocks() {
        let db = build_ls_r([
            "tex/latex/base/article.cls",
            "tex/latex/amsmath/amsmath.sty",
            "web2c/texmf.cnf",
        ]);
        assert!(db.starts_with("% ls-R -- filename database for kpathsea"));
        assert!(db.contains("\n./:\ntex\nweb2c\n"), "{db}");
        assert!(db.contains("\n./tex/latex:\namsmath\nbase\n"), "{db}");
        assert!(db.contains("\n./tex/latex/base:\narticle.cls\n"), "{db}");
        assert!(db.contains("\n./web2c:\ntexmf.cnf\n"), "{db}");
    }

    #[test]
    fn does_not_index_the_db_itself() {
        let db = build_ls_r(["ls-R", "tex/a.sty"]);
        assert!(!db.contains("\nls-R\n"), "{db}");
    }

    #[test]
    fn deduplicates_shared_parents() {
        let db = build_ls_r(["fonts/tfm/a.tfm", "fonts/tfm/b.tfm"]);
        assert_eq!(db.matches("./fonts:").count(), 1, "{db}");
        assert!(db.contains("\n./fonts/tfm:\na.tfm\nb.tfm\n"), "{db}");
    }

    #[test]
    fn empty_input_is_just_the_header() {
        assert_eq!(
            build_ls_r(Vec::<String>::new()),
            "% ls-R -- filename database for kpathsea; do not change this line.\n"
        );
    }
}
