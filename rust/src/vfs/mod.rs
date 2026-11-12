//! VFS layer chain — bundle handling, tar, and integrity wrappers.
//!
//! The chain itself (BundleFS → OPFS/TauriFS → FETCHFS) is assembled on the
//! host side, where the storage and network APIs live. The pieces here are the
//! host-independent parts: tar parsing, gzip decompression, bundle format
//! detection and unpacking, and the manifest-backed integrity gate.

pub mod bundlefs;
pub mod tar;

pub use bundlefs::{
    detect_format, load_bundle, require_integrity, unpack_bundle_tar, BundleFormat, BundleLoad,
    BundleOptions, MAX_COMPRESSED_BYTES,
};
pub use tar::{
    decompress, untar, CompressionFormat, TarEntry, TarEntryType, MAX_DECOMPRESSED_BYTES,
    MAX_TAR_ENTRIES,
};
