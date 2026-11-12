//! BundleFS — serving a TL TDS subset that was preloaded into memory.
//!
//! Rust port of the byte-handling half of `src/vfs/bundlefs.ts`. The bundle is
//! a gzip-/brotli-wrapped tar of `texmf-dist/*` paths; fetching it is the
//! host's job, unpacking and confining it is this module's.

use std::collections::BTreeMap;

use crate::core::manifest::assert_sha256;
use crate::core::paths::safe_relative_path;
use crate::vfs::tar::{decompress, untar, CompressionFormat, MAX_DECOMPRESSED_BYTES};

/// Ceiling on the bundle we are willing to download (~120 MB compressed).
pub const MAX_COMPRESSED_BYTES: usize = 256 * 1024 * 1024;

/// The compression a bundle is wrapped in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleFormat {
    Gzip,
    Br,
    Raw,
}

impl BundleFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            BundleFormat::Gzip => "gzip",
            BundleFormat::Br => "br",
            BundleFormat::Raw => "raw",
        }
    }
}

/// Identify the bundle's compression, or `None` when nothing identifies it.
///
/// Brotli has no magic bytes, so it can only be asserted (by the `.tar.br`
/// suffix or an explicit format) — never inferred. Guessing 'br' for "anything
/// else" fed every unrecognized byte stream into a brotli decoder.
pub fn detect_format(url: Option<&str>, bytes: &[u8]) -> Option<BundleFormat> {
    if let Some(url) = url {
        // Query strings and fragments are legal on an asset URL.
        let path = url.split(['?', '#']).next().unwrap_or(url);
        if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
            return Some(BundleFormat::Gzip);
        }
        if path.ends_with(".tar.br") {
            return Some(BundleFormat::Br);
        }
        if path.ends_with(".tar") {
            return Some(BundleFormat::Raw);
        }
    }
    // gzip has magic bytes 1F 8B.
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return Some(BundleFormat::Gzip);
    }
    // A plain tar has "ustar" at offset 257 of the first header block.
    if bytes.len() >= 262 && &bytes[257..262] == b"ustar" {
        return Some(BundleFormat::Raw);
    }
    None
}

/// What unpacking a bundle produced, plus what was dropped on the way.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BundleLoad {
    /// TDS-relative path → file bytes.
    pub files: BTreeMap<String, Vec<u8>>,
    /// Entries dropped because their name escaped the tree.
    pub rejected: usize,
    /// The first rejected entry name (for the warning message).
    pub first_rejected: Option<String>,
    /// Entries dropped because an earlier entry already claimed the name.
    pub duplicates: usize,
}

/// Options controlling how a fetched bundle is validated and unpacked.
#[derive(Debug, Clone, Default)]
pub struct BundleOptions {
    pub format: Option<BundleFormat>,
    /// SHA-256 the bytes must hash to.
    pub sha256: Option<String>,
    /// Load a bundle nothing pins. Development escape hatch.
    pub allow_unverified: bool,
    /// Whether the bundle URL shares the app's origin.
    pub same_origin: bool,
    pub strip_prefix: Option<String>,
    pub max_bytes: Option<usize>,
    pub max_compressed_bytes: Option<usize>,
}

/// A bundle we fetch is the entire TeX tree the engine executes, so bytes for
/// it must be pinned by a digest unless they come from our own origin.
pub fn require_integrity(
    bundle_url: &str,
    sha256: Option<&str>,
    allow_unverified: bool,
    same_origin: bool,
) -> Result<(), String> {
    if sha256.is_some() || allow_unverified || same_origin {
        return Ok(());
    }
    Err(format!(
        "BundleFs: refusing to load {bundle_url} — no SHA-256 for it. Publish the digest in the \
         manifest (coreBundleSha256), pass it as `sha256`, or serve the bundle from the app's own \
         origin. For development only, set allowUnverified/allowUnverifiedAssets."
    ))
}

/// Validate and unpack a downloaded bundle into a TDS map.
pub fn load_bundle(
    bytes: &[u8],
    url: Option<&str>,
    opts: &BundleOptions,
) -> Result<BundleLoad, String> {
    let what = url.unwrap_or("the supplied bundle");
    require_integrity(
        what,
        opts.sha256.as_deref(),
        opts.allow_unverified,
        opts.same_origin,
    )?;

    let max_compressed = opts.max_compressed_bytes.unwrap_or(MAX_COMPRESSED_BYTES);
    if bytes.len() > max_compressed {
        return Err(format!(
            "BundleFs: {what} is {} bytes, past the {max_compressed}-byte download limit; refusing to unpack it",
            bytes.len()
        ));
    }

    // Verify the compressed blob before unpacking it: everything in here is
    // fed straight to the engine, so a poisoned bundle is arbitrary TeX.
    if let Some(expected) = opts.sha256.as_deref() {
        assert_sha256(bytes, expected, what)?;
    }

    let format = match opts.format.or_else(|| detect_format(url, bytes)) {
        Some(f) => f,
        None => {
            return Err(format!(
                "BundleFs: cannot tell what {what} is compressed with — it is neither gzip nor a \
                 plain tar. Brotli has no magic bytes, so name the file .tar.br or pass \
                 format: 'br' explicitly."
            ));
        }
    };

    let max_bytes = opts.max_bytes.unwrap_or(MAX_DECOMPRESSED_BYTES);
    let tar =
        match format {
            BundleFormat::Raw => bytes.to_vec(),
            BundleFormat::Gzip => decompress(bytes, CompressionFormat::Gzip, max_bytes)?,
            BundleFormat::Br => return Err(
                "BundleFs: brotli decompression runs in the host; pass already-decompressed tar \
                 bytes or an explicit format"
                    .to_string(),
            ),
        };

    unpack_bundle_tar(&tar, opts.strip_prefix.as_deref().unwrap_or("texmf/"))
}

/// Unpack a plain tar into `BundleLoad`, applying the same confinement rules as
/// the TS `createBundleFs().load()`.
pub fn unpack_bundle_tar(tar: &[u8], strip_prefix: &str) -> Result<BundleLoad, String> {
    let mut load = BundleLoad::default();
    for entry in untar(tar, None)? {
        if entry.entry_type != crate::vfs::tar::TarEntryType::File {
            continue;
        }
        let mut path = entry.path.as_str();
        if let Some(rest) = path.strip_prefix(strip_prefix) {
            path = rest;
        }
        // Tar entry names are attacker-controlled if the bundle is. A `..`
        // climbs out of the tree; an absolute name is not something tar
        // produces, so treat it as the red flag it is.
        let safe = if path.starts_with('/') {
            None
        } else {
            safe_relative_path(path)
        };
        let Some(safe) = safe else {
            load.rejected += 1;
            load.first_rejected
                .get_or_insert_with(|| entry.path.clone());
            continue;
        };
        // A second entry for the same name: first one wins.
        if load.files.contains_key(&safe) {
            load.duplicates += 1;
            continue;
        }
        load.files.insert(safe, entry.content);
    }
    Ok(load)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_extension_and_magic() {
        assert_eq!(
            detect_format(Some("x.tar.gz"), &[]),
            Some(BundleFormat::Gzip)
        );
        assert_eq!(
            detect_format(Some("x.tgz?cache=1"), &[]),
            Some(BundleFormat::Gzip)
        );
        assert_eq!(detect_format(Some("x.tar.br"), &[]), Some(BundleFormat::Br));
        assert_eq!(detect_format(Some("x.tar"), &[]), Some(BundleFormat::Raw));
        assert_eq!(
            detect_format(None, &[0x1f, 0x8b, 0]),
            Some(BundleFormat::Gzip)
        );
        let mut ustar = vec![0u8; 262];
        ustar[257..262].copy_from_slice(b"ustar");
        assert_eq!(detect_format(None, &ustar), Some(BundleFormat::Raw));
        assert_eq!(detect_format(None, &[0, 1, 2]), None);
    }

    #[test]
    fn integrity_required_unless_pinned_or_same_origin() {
        assert!(require_integrity("https://cdn/x.tar.gz", None, false, false).is_err());
        assert!(require_integrity("https://cdn/x.tar.gz", Some("ab"), false, false).is_ok());
        assert!(require_integrity("https://cdn/x.tar.gz", None, true, false).is_ok());
        assert!(require_integrity("https://cdn/x.tar.gz", None, false, true).is_ok());
    }
}
