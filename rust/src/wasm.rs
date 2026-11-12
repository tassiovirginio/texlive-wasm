//! `wasm-bindgen` bindings — the JavaScript-facing surface of the Rust core.
//!
//! Compiled only for `wasm32` with the `wasm` feature. Each function mirrors
//! the TS helper of the same name, so a JS caller can swap
//! `import { safeRelativePath } from '.../paths'` for
//! `import { safeRelativePath } from 'texlive-wasm/rust'`.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::core::types::{EngineId, FileInput};
use crate::core::{kpse, lsr, manifest, missing, paths};
use crate::engines;
use crate::latexmk::{self, Rerun};
use crate::synctex;
use crate::vfs::bundlefs::{self, BundleOptions};

fn js_err(msg: String) -> JsValue {
    JsValue::from_str(&msg)
}

// ----- paths ----------------------------------------------------------------

#[wasm_bindgen(js_name = safeRelativePath)]
pub fn safe_relative_path(path: &str) -> Option<String> {
    paths::safe_relative_path(path)
}

#[wasm_bindgen(js_name = safeResolve)]
pub fn safe_resolve(root: &str, path: &str) -> Option<String> {
    paths::safe_resolve(root, path)
}

// ----- ls-R / kpathsea ------------------------------------------------------

#[wasm_bindgen(js_name = buildLsR)]
pub fn build_ls_r(paths: Vec<String>) -> String {
    lsr::build_ls_r(paths)
}

#[wasm_bindgen(js_name = tdsRelative)]
pub fn tds_relative(abs_path: &str) -> Option<String> {
    kpse::tds_relative(abs_path)
}

#[wasm_bindgen(js_name = tdsAbsolute)]
pub fn tds_absolute(rel: &str, mount: Option<String>) -> String {
    kpse::tds_absolute(rel, mount.as_deref().unwrap_or("/texmf-dist"))
}

// ----- missing files --------------------------------------------------------

#[wasm_bindgen(js_name = parseMissingFiles)]
pub fn parse_missing_files(log: &str) -> Vec<String> {
    missing::parse_missing_files(log)
}

#[wasm_bindgen(js_name = expandMissingName)]
pub fn expand_missing_name(name: &str) -> Vec<String> {
    missing::expand_missing_name(name)
}

// ----- manifest -------------------------------------------------------------

#[wasm_bindgen]
pub struct Manifest {
    inner: manifest::TexPackagesManifest,
}

#[wasm_bindgen]
impl Manifest {
    /// Parse and validate a `tex-packages.json` string.
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: &str) -> Result<Manifest, JsValue> {
        manifest::parse_manifest(json)
            .map(|inner| Manifest { inner })
            .map_err(js_err)
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        self.inner.version.clone()
    }

    #[wasm_bindgen(js_name = tierOf)]
    pub fn tier_of(&self, tds_path: &str) -> Option<String> {
        self.inner
            .tier_of(tds_path)
            .map(|t| format!("{t:?}").to_lowercase())
    }

    #[wasm_bindgen(js_name = packageOf)]
    pub fn package_of(&self, tds_path: &str) -> Option<String> {
        self.inner.package_of(tds_path).map(str::to_string)
    }

    #[wasm_bindgen(js_name = expectedSha256)]
    pub fn expected_sha256(&self, tds_path: &str) -> Option<String> {
        self.inner.expected_sha256(tds_path).map(str::to_string)
    }

    #[wasm_bindgen(js_name = fileCount)]
    pub fn file_count(&self) -> usize {
        self.inner.files.len()
    }
}

#[wasm_bindgen(js_name = sha256Hex)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    manifest::sha256_hex(bytes)
}

// ----- vfs: tar / bundles ---------------------------------------------------

#[wasm_bindgen(js_name = untar)]
pub fn untar(bytes: &[u8], max_entries: Option<f64>) -> Result<js_sys::Array, JsValue> {
    let entries = crate::vfs::tar::untar(bytes, max_entries.map(|n| n as usize)).map_err(js_err)?;
    let array = js_sys::Array::new();
    for entry in entries {
        let obj = js_sys::Object::new();
        let kind = match entry.entry_type {
            crate::vfs::tar::TarEntryType::File => "file",
            crate::vfs::tar::TarEntryType::Dir => "dir",
            crate::vfs::tar::TarEntryType::Other => "other",
        };
        set(&obj, "path", &JsValue::from_str(&entry.path))?;
        set(&obj, "type", &JsValue::from_str(kind))?;
        set(
            &obj,
            "content",
            &js_sys::Uint8Array::from(entry.content.as_slice()),
        )?;
        array.push(&obj);
    }
    Ok(array)
}

#[wasm_bindgen(js_name = detectBundleFormat)]
pub fn detect_bundle_format(url: Option<String>, bytes: &[u8]) -> Option<String> {
    bundlefs::detect_format(url.as_deref(), bytes).map(|f| f.as_str().to_string())
}

#[wasm_bindgen(js_name = decompress)]
pub fn decompress(bytes: &[u8], format: &str, max_bytes: Option<f64>) -> Result<Vec<u8>, JsValue> {
    let format = match format {
        "gzip" => crate::vfs::tar::CompressionFormat::Gzip,
        "deflate-raw" => crate::vfs::tar::CompressionFormat::DeflateRaw,
        "br" => crate::vfs::tar::CompressionFormat::Br,
        other => return Err(js_err(format!("unknown compression format: {other}"))),
    };
    let max = max_bytes
        .map(|n| n as usize)
        .unwrap_or(crate::vfs::tar::MAX_DECOMPRESSED_BYTES);
    crate::vfs::tar::decompress(bytes, format, max).map_err(js_err)
}

/// Unpack a plain (already decompressed) bundle tar into a JS object mapping
/// TDS-relative path → Uint8Array.
#[wasm_bindgen(js_name = unpackBundleTar)]
pub fn unpack_bundle_tar(
    tar: &[u8],
    strip_prefix: Option<String>,
) -> Result<js_sys::Object, JsValue> {
    let load = bundlefs::unpack_bundle_tar(tar, strip_prefix.as_deref().unwrap_or("texmf/"))
        .map_err(js_err)?;
    files_to_object(load.files)
}

/// Fully validate and unpack a downloaded bundle. `opts` is a JSON
/// `BundleOptions` (format, sha256, allowUnverified, sameOrigin, stripPrefix,
/// maxBytes, maxCompressedBytes).
#[wasm_bindgen(js_name = loadBundle)]
pub fn load_bundle(
    bytes: &[u8],
    url: Option<String>,
    opts_json: &str,
) -> Result<js_sys::Object, JsValue> {
    let opts: JsBundleOptions = serde_json::from_str(opts_json)
        .map_err(|e| js_err(format!("invalid BundleOptions: {e}")))?;
    let load = bundlefs::load_bundle(bytes, url.as_deref(), &opts.into()).map_err(js_err)?;
    let out = js_sys::Object::new();
    set(&out, "files", &files_to_object(load.files)?.into())?;
    set(&out, "rejected", &JsValue::from_f64(load.rejected as f64))?;
    set(
        &out,
        "duplicates",
        &JsValue::from_f64(load.duplicates as f64),
    )?;
    Ok(out)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JsBundleOptions {
    format: Option<String>,
    sha256: Option<String>,
    #[serde(default)]
    allow_unverified: bool,
    #[serde(default)]
    same_origin: bool,
    strip_prefix: Option<String>,
    max_bytes: Option<f64>,
    max_compressed_bytes: Option<f64>,
}

impl From<JsBundleOptions> for BundleOptions {
    fn from(o: JsBundleOptions) -> Self {
        BundleOptions {
            format: o.format.as_deref().and_then(|f| match f {
                "gzip" => Some(bundlefs::BundleFormat::Gzip),
                "br" => Some(bundlefs::BundleFormat::Br),
                "raw" => Some(bundlefs::BundleFormat::Raw),
                _ => None,
            }),
            sha256: o.sha256,
            allow_unverified: o.allow_unverified,
            same_origin: o.same_origin,
            strip_prefix: o.strip_prefix,
            max_bytes: o.max_bytes.map(|n| n as usize),
            max_compressed_bytes: o.max_compressed_bytes.map(|n| n as usize),
        }
    }
}

// ----- latexmk --------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Deserialize)]
struct JsFileInput {
    path: String,
    content: Content,
}

fn files_from_json(json: &str) -> Result<Vec<FileInput>, JsValue> {
    let raw: Vec<JsFileInput> =
        serde_json::from_str(json).map_err(|e| js_err(format!("invalid files JSON: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|f| {
            let content = match f.content {
                Content::Text(s) => s.into_bytes(),
                Content::Bytes(b) => b,
            };
            FileInput {
                path: f.path,
                content,
            }
        })
        .collect())
}

#[wasm_bindgen(js_name = willRunBibtex)]
pub fn will_run_bibtex(files_json: &str) -> Result<bool, JsValue> {
    Ok(latexmk::will_run_bibtex(&files_from_json(files_json)?))
}

#[wasm_bindgen(js_name = willRunBiber)]
pub fn will_run_biber(files_json: &str) -> Result<bool, JsValue> {
    Ok(latexmk::will_run_biber(&files_from_json(files_json)?))
}

#[wasm_bindgen(js_name = detectMakeindex)]
pub fn detect_makeindex(files_json: &str) -> Result<bool, JsValue> {
    Ok(latexmk::detect_makeindex(&files_from_json(files_json)?))
}

#[wasm_bindgen(js_name = rerunRequested)]
pub fn rerun_requested(log: &str) -> bool {
    latexmk::rerun_requested(log)
}

/// `mode` is the rerun option as JSON (`true`, `false`, `"auto"`, or
/// `{"maxPasses":N}`).
#[wasm_bindgen(js_name = maxPasses)]
pub fn max_passes(mode: &str, biblatex_mode: bool) -> Result<usize, JsValue> {
    let value: serde_json::Value =
        serde_json::from_str(mode).map_err(|e| js_err(format!("invalid rerun mode: {e}")))?;
    let rerun = match value {
        serde_json::Value::Bool(false) => Rerun::Never,
        serde_json::Value::Bool(true) => Rerun::Auto,
        serde_json::Value::String(s) if s == "auto" => Rerun::Auto,
        serde_json::Value::Object(o) => {
            let n = o.get("maxPasses").and_then(|v| v.as_u64()).unwrap_or(1);
            Rerun::MaxPasses(n as usize)
        }
        other => return Err(js_err(format!("invalid rerun mode: {other}"))),
    };
    Ok(latexmk::max_passes(rerun, biblatex_mode))
}

#[wasm_bindgen(js_name = projectPaths)]
pub fn project_paths(main_tex: &str) -> Result<js_sys::Object, JsValue> {
    let p = latexmk::project_paths(main_tex);
    let out = js_sys::Object::new();
    set(&out, "base", &JsValue::from_str(&p.base))?;
    set(&out, "aux", &JsValue::from_str(&p.aux))?;
    set(&out, "bcf", &JsValue::from_str(&p.bcf))?;
    set(&out, "idx", &JsValue::from_str(&p.idx))?;
    set(&out, "xdv", &JsValue::from_str(&p.xdv))?;
    set(&out, "pdf", &JsValue::from_str(&p.pdf))?;
    set(&out, "log", &JsValue::from_str(&p.log))?;
    set(&out, "synctex", &JsValue::from_str(&p.synctex))?;
    Ok(out)
}

// ----- engines --------------------------------------------------------------

#[wasm_bindgen(js_name = engineArgs)]
pub fn engine_args(engine: &str, options_json: &str) -> Result<Vec<String>, JsValue> {
    let id = EngineId::parse(engine).ok_or_else(|| js_err(format!("unknown engine: {engine}")))?;
    engines::compile_args(id, options_json).map_err(js_err)
}

// ----- synctex --------------------------------------------------------------

#[wasm_bindgen(js_name = synctexInputFiles)]
pub fn synctex_input_files(bytes: &[u8]) -> Result<Vec<String>, JsValue> {
    Ok(synctex::create_synctex(bytes).map_err(js_err)?.files())
}

// ----- helpers --------------------------------------------------------------

fn set(obj: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), value).map(|_| ())
}

fn files_to_object(
    files: std::collections::BTreeMap<String, Vec<u8>>,
) -> Result<js_sys::Object, JsValue> {
    let out = js_sys::Object::new();
    for (path, bytes) in files {
        set(&out, &path, &js_sys::Uint8Array::from(bytes.as_slice()))?;
    }
    Ok(out)
}
