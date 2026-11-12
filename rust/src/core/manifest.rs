//! `tex-packages.json` — content-addressed manifest of TL files.
//!
//! Rust port of the parsing/lookup half of `src/core/manifest.ts`. Fetching a
//! manifest is left to the host (JS `fetch`, or any HTTP client when this crate
//! is used natively); everything after the bytes arrive lives here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type ManifestTier = Tier;

/// Which delivery tier a file ships in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Core,
    Full,
    Cdn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// SHA-256 of the file's bytes, hex.
    pub sha256: String,
    /// File size in bytes.
    pub size: u64,
    /// Which delivery tier this file ships in.
    pub tier: Tier,
    /// CTAN package the file belongs to (best-effort; `null` for orphans).
    pub package: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TexPackagesManifest {
    /// Manifest format version. Bumped on schema changes.
    pub schema: u32,
    /// Versioned build identifier, e.g. "texlive-2026-r0".
    pub version: String,
    /// When the manifest was built (ISO 8601).
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// Brotli-compressed core-tier bundle.
    #[serde(rename = "coreBundleUrl")]
    pub core_bundle_url: Option<String>,
    /// SHA-256 of the core bundle's compressed bytes, hex. Optional.
    #[serde(rename = "coreBundleSha256", default)]
    pub core_bundle_sha256: Option<String>,
    /// Brotli-compressed full-tier bundle (downloaded once on first run).
    #[serde(rename = "fullBundleUrl")]
    pub full_bundle_url: Option<String>,
    /// SHA-256 of the full bundle's compressed bytes, hex. Optional.
    #[serde(rename = "fullBundleSha256", default)]
    pub full_bundle_sha256: Option<String>,
    /// CDN base URL for per-file long-tail fetches.
    #[serde(rename = "cdnBaseUrl")]
    pub cdn_base_url: Option<String>,
    /// TDS-relative path → entry.
    pub files: BTreeMap<String, ManifestEntry>,
}

impl TexPackagesManifest {
    pub fn tier_of(&self, tds_path: &str) -> Option<Tier> {
        self.files.get(tds_path).map(|e| e.tier)
    }

    pub fn package_of(&self, tds_path: &str) -> Option<&str> {
        self.files.get(tds_path).and_then(|e| e.package.as_deref())
    }

    pub fn expected_sha256(&self, tds_path: &str) -> Option<&str> {
        self.files.get(tds_path).map(|e| e.sha256.as_str())
    }
}

/// Parse a manifest and reject unknown schemas — the TS `loadManifest()` does
/// the same check after decoding the JSON.
pub fn parse_manifest(json: &str) -> Result<TexPackagesManifest, String> {
    let manifest: TexPackagesManifest =
        serde_json::from_str(json).map_err(|e| format!("invalid manifest JSON: {e}"))?;
    if manifest.schema != 1 {
        return Err(format!("Unsupported manifest schema: {}", manifest.schema));
    }
    if manifest.version.trim().is_empty() || manifest.generated_at.trim().is_empty() {
        return Err("Invalid manifest metadata".into());
    }
    let valid_hash = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    for digest in [&manifest.core_bundle_sha256, &manifest.full_bundle_sha256]
        .into_iter()
        .flatten()
    {
        if !valid_hash(digest) {
            return Err("Invalid manifest bundle hash".into());
        }
    }
    for (path, entry) in &manifest.files {
        if crate::core::paths::safe_relative_path(path).as_deref() != Some(path.as_str())
            || !valid_hash(&entry.sha256)
            || entry.size > 9_007_199_254_740_991
        {
            return Err(format!("Invalid manifest file: {path}"));
        }
    }
    Ok(manifest)
}

/// SHA-256 of `bytes` as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Throw unless `bytes` hashes to `expected`. Used on whole blobs — the core
/// bundle, a CDN file — where a poisoned byte stream would otherwise be
/// executed as TeX macros or cached for every later session.
pub fn assert_sha256(bytes: &[u8], expected: &str, what: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual != expected.to_ascii_lowercase() {
        return Err(format!(
            "texlive-wasm: integrity check failed for {what}: expected sha256 {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// Whether `bytes` match the manifest digest for `tds_path`. Files the manifest
/// does not list are rejected by the verified cache/CDN layers.
pub fn matches(manifest: &TexPackagesManifest, tds_path: &str, bytes: &[u8]) -> bool {
    let path = tds_path.trim_start_matches('/');
    match manifest.expected_sha256(path) {
        None => false,
        Some(expected) => sha256_hex(bytes) == expected.to_ascii_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{
      "schema": 1,
      "version": "texlive-2026-r0",
      "generatedAt": "2026-01-01T00:00:00Z",
      "coreBundleUrl": "core.tar.br",
      "fullBundleUrl": null,
      "cdnBaseUrl": null,
      "files": {
        "tex/latex/base/article.cls": {
          "sha256": "abababababababababababababababababababababababababababababababab",
          "size": 12, "tier": "core", "package": "base"
        },
        "tex/latex/geometry/geometry.sty": {
          "sha256": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
          "size": 34, "tier": "cdn", "package": "geometry"
        }
      }
    }"#;

    #[test]
    fn parses_and_looks_up() {
        let m = parse_manifest(JSON).unwrap();
        assert_eq!(m.version, "texlive-2026-r0");
        assert_eq!(m.files.len(), 2);
        assert_eq!(m.tier_of("tex/latex/base/article.cls"), Some(Tier::Core));
        assert_eq!(
            m.package_of("tex/latex/geometry/geometry.sty"),
            Some("geometry")
        );
        assert_eq!(
            m.expected_sha256("tex/latex/base/article.cls"),
            Some("ab".repeat(32).as_str())
        );
        assert_eq!(m.tier_of("nope"), None);
        assert_eq!(m.package_of("nope"), None);
        assert_eq!(m.expected_sha256("nope"), None);
    }

    #[test]
    fn rejects_unknown_schema() {
        let bad = JSON.replace("\"schema\": 1", "\"schema\": 2");
        let err = parse_manifest(&bad).unwrap_err();
        assert!(err.contains("Unsupported manifest schema"), "{err}");
    }

    #[test]
    fn sha256_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn integrity_rejects_unknown_files() {
        let m = parse_manifest(JSON).unwrap();
        // Unlisted path is rejected.
        assert!(!matches(&m, "whatever.sty", b"x"));
        // Listed path with wrong bytes → reject.
        assert!(!matches(&m, "tex/latex/base/article.cls", b"nope"));
    }
}
