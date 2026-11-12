//! SyncTeX parsing — port of `src/synctex/index.ts`.
//!
//! The `.synctex.gz` format is a small text format. As in the TS wrapper, this
//! currently extracts the input-file list; forward/reverse position lookup is
//! still TODO (Phase 4 upstream), so those APIs are intentionally absent.
//!
//! gzip decompression uses `flate2` (pure-Rust backend) rather than the host's
//! `DecompressionStream`, so the same code runs natively and on wasm.

use std::io::Read;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedSynctex {
    /// input id → filename, in first-seen order.
    pub inputs: Vec<(String, String)>,
    /// Raw record lines (structured into a tree in Phase 4).
    pub records: Vec<String>,
}

impl ParsedSynctex {
    /// All input files referenced in the synctex index.
    pub fn files(&self) -> Vec<String> {
        self.inputs.iter().map(|(_, name)| name.clone()).collect()
    }
}

/// Parse a `.synctex.gz` (or already-decompressed `.synctex`) buffer.
pub fn create_synctex(bytes: &[u8]) -> Result<ParsedSynctex, String> {
    let decompressed = if is_gzip(bytes) {
        gunzip(bytes)?
    } else {
        bytes.to_vec()
    };
    let text = String::from_utf8_lossy(&decompressed);
    Ok(parse_synctex(&text))
}

pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// Synchronous gzip decompress (used where a host `DecompressionStream` is not
/// available, e.g. native or a non-browser wasm host).
pub fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .map_err(|e| format!("synctex: gzip decompression failed: {e}"))?;
    Ok(out)
}

/// Parse the synctex text, extracting `Input:<id>:<filename>` records.
pub fn parse_synctex(text: &str) -> ParsedSynctex {
    let mut parsed = ParsedSynctex::default();
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("Input:") {
            if let Some(colon) = rest.find(':') {
                if colon > 0 {
                    let id = rest[..colon].to_string();
                    let name = rest[colon + 1..].to_string();
                    // Mirrors JS object assignment: a duplicate id updates in
                    // place, keeping the original position.
                    if let Some(slot) = parsed.inputs.iter_mut().find(|(k, _)| *k == id) {
                        slot.1 = name;
                    } else {
                        parsed.inputs.push((id, name));
                    }
                }
            }
        } else if !line.is_empty() {
            parsed.records.push(line.to_string());
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_input_files() {
        let text = "SyncTeX Version:1\nInput:1:/project/main.tex\nInput:2:/texmf-dist/tex/a.sty\n\
                    Content:\n{1\n";
        let parsed = parse_synctex(text);
        assert_eq!(
            parsed.files(),
            ["/project/main.tex", "/texmf-dist/tex/a.sty"]
        );
        assert!(parsed.records.iter().any(|r| r == "SyncTeX Version:1"));
    }

    #[test]
    fn duplicate_ids_update_in_place() {
        let parsed = parse_synctex("Input:1:a.tex\nInput:1:b.tex\n");
        assert_eq!(parsed.inputs, vec![("1".to_string(), "b.tex".to_string())]);
    }

    #[test]
    fn gzip_round_trip() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let src = b"Input:1:/x.tex\n";
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(src).unwrap();
        let gz = enc.finish().unwrap();
        assert!(is_gzip(&gz));
        let parsed = create_synctex(&gz).unwrap();
        assert_eq!(parsed.files(), ["/x.tex"]);
        assert_eq!(create_synctex(src).unwrap().files(), ["/x.tex"]);
    }
}
