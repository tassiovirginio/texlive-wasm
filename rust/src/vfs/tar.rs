//! Tiny streaming tar parser (POSIX ustar format) — port of `src/vfs/tar.ts`.
//!
//! Used by BundleFS to extract a `.tar` (or gzip/brotli-wrapped tar) into a
//! map for MEMFS upload. Hand-rolled on purpose: tar is 512-byte fixed headers
//! and a dependency is not worth it.

use std::io::Read;

/// Ceiling on the entry count of a single archive. The full TL 2026 tree is
/// roughly 180k files; the bundles we publish are far smaller.
pub const MAX_TAR_ENTRIES: usize = 250_000;

/// Ceiling on what a single archive may expand to (~275 MB is the real tree).
pub const MAX_DECOMPRESSED_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TarEntryType {
    File,
    Dir,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TarEntry {
    pub path: String,
    pub content: Vec<u8>,
    pub entry_type: TarEntryType,
}

/// Parse a tar archive into a list of entries.
///
/// A malformed or hostile archive is an error, not a shorter list: a header
/// whose declared size runs past the end of the buffer, or an entry count no
/// TDS could have, means the bytes are not the archive we asked for. Entry
/// NAMES are not judged here — the caller owns the root they unpack into and
/// confines them with [`crate::core::paths::safe_relative_path`].
pub fn untar(bytes: &[u8], max_entries: Option<usize>) -> Result<Vec<TarEntry>, String> {
    let max_entries = max_entries.unwrap_or(MAX_TAR_ENTRIES);
    let mut out: Vec<TarEntry> = Vec::new();
    let mut offset: u64 = 0;
    let len = bytes.len() as u64;
    // POSIX ustar prefix support (long pathnames).
    let mut pending_long_name: Option<String> = None;

    while offset + 512 <= len {
        let start = offset as usize;
        let block = &bytes[start..start + 512];
        if is_all_zero(block) {
            // Trailing zero block(s) signal end of archive.
            break;
        }

        let name = read_cstring(block, 0, 100);
        let size = parse_octal(block, 124, 12);
        let typeflag = block[156] as char;
        let prefix = read_cstring(block, 345, 155);
        let full_path = match pending_long_name.take() {
            Some(long) => long,
            None if prefix.is_empty() => name,
            None => format!("{prefix}/{name}"),
        };

        offset += 512;
        // A size that overruns the buffer means the header is lying (or the
        // download was truncated); a short read would let the engine compile
        // with half a file.
        if offset + size > len {
            return Err(format!(
                "texlive-wasm: tar entry \"{full_path}\" declares {size} bytes, past the end of the archive"
            ));
        }
        let content_blocks = size.div_ceil(512);
        let content_start = offset as usize;
        let content = bytes[content_start..content_start + size as usize].to_vec();
        offset += content_blocks * 512;

        if out.len() >= max_entries {
            return Err(format!(
                "texlive-wasm: tar archive has more than {max_entries} entries; refusing to continue"
            ));
        }

        if typeflag == 'L' {
            // GNU long-name extension: next entry's name is this content.
            pending_long_name = Some(
                String::from_utf8_lossy(&content)
                    .trim_end_matches('\0')
                    .to_string(),
            );
            continue;
        }
        if typeflag == 'x' {
            // PAX extended header: may carry a `path` record overriding the
            // (possibly truncated) ustar name of the NEXT entry.
            if let Some(pax_path) = parse_pax_path(&String::from_utf8_lossy(&content)) {
                pending_long_name = Some(pax_path);
            }
            continue;
        }
        if typeflag == 'g' {
            // PAX global header — no per-entry data we care about.
            continue;
        }

        let entry_type = match typeflag {
            '5' => TarEntryType::Dir,
            '0' | '\0' => TarEntryType::File,
            _ => TarEntryType::Other,
        };
        out.push(TarEntry {
            path: full_path,
            content: if entry_type == TarEntryType::File {
                content
            } else {
                Vec::new()
            },
            entry_type,
        });
    }
    Ok(out)
}

/// PAX extended-header body is a sequence of "<len> <key>=<value>\n" records
/// where <len> counts the whole record in bytes. Returns the `path` value.
fn parse_pax_path(body: &str) -> Option<String> {
    let mut i = 0usize;
    while i < body.len() {
        let space = body.get(i..)?.find(' ')? + i;
        let len: usize = body.get(i..space)?.parse().ok()?;
        if len == 0 || i + len > body.len() {
            break;
        }
        let record = body.get(space + 1..i + len)?;
        if let Some(eq) = record.find('=') {
            if eq > 0 && &record[..eq] == "path" {
                return Some(record[eq + 1..].trim_end_matches('\n').to_string());
            }
        }
        i += len;
    }
    None
}

fn read_cstring(block: &[u8], start: usize, len: usize) -> String {
    let end_limit = (start + len).min(block.len());
    let mut end = start;
    while end < end_limit && block[end] != 0 {
        end += 1;
    }
    String::from_utf8_lossy(&block[start..end]).into_owned()
}

fn parse_octal(block: &[u8], start: usize, len: usize) -> u64 {
    let mut n: u64 = 0;
    let end = (start + len).min(block.len());
    for &c in &block[start..end] {
        if c == 0 || c == 0x20 {
            continue;
        }
        if !(0x30..=0x37).contains(&c) {
            break;
        }
        n = n * 8 + (c - 0x30) as u64;
    }
    n
}

fn is_all_zero(block: &[u8]) -> bool {
    block.iter().all(|&b| b == 0)
}

/// Compression formats `decompress` understands natively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionFormat {
    Gzip,
    DeflateRaw,
    /// Brotli. Not built into the Rust core (no `brotli` dependency); on wasm
    /// the host's `DecompressionStream('br')` handles it. Calling
    /// [`decompress`] with this returns an error.
    Br,
}

impl CompressionFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            CompressionFormat::Gzip => "gzip",
            CompressionFormat::DeflateRaw => "deflate-raw",
            CompressionFormat::Br => "br",
        }
    }
}

/// Decompress a gzip- or deflate-raw-wrapped buffer, bounded as it streams —
/// checking the size after the fact would mean the bomb has already been
/// allocated.
pub fn decompress(
    bytes: &[u8],
    format: CompressionFormat,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    match format {
        CompressionFormat::Gzip => {
            read_capped(flate2::read::GzDecoder::new(bytes), max_bytes, "gzip")
        }
        CompressionFormat::DeflateRaw => read_capped(
            flate2::read::DeflateDecoder::new(bytes),
            max_bytes,
            "deflate-raw",
        ),
        CompressionFormat::Br => Err(
            "texlive-wasm: brotli decompression is not built into the Rust core; use the host \
             DecompressionStream('br') on wasm"
                .to_string(),
        ),
    }
}

fn read_capped<R: Read>(mut r: R, max_bytes: usize, format: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = r
            .read(&mut buf)
            .map_err(|e| format!("{format} decompression failed: {e}"))?;
        if n == 0 {
            break;
        }
        if out.len() + n > max_bytes {
            return Err(format!(
                "texlive-wasm: {format} stream expands past the {max_bytes}-byte limit; refusing to continue"
            ));
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal ustar archive for tests (mirrors `test/helpers.ts`).
    struct Spec<'a> {
        path: &'a str,
        content: &'a [u8],
        typeflag: u8,
        declared_size: Option<u64>,
    }

    fn spec<'a>(path: &'a str, content: &'a [u8]) -> Spec<'a> {
        Spec {
            path,
            content,
            typeflag: b'0',
            declared_size: None,
        }
    }

    fn build_tar(specs: &[Spec<'_>]) -> Vec<u8> {
        let mut out = Vec::new();
        for s in specs {
            let mut header = [0u8; 512];
            let name = s.path.as_bytes();
            header[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
            let size = s.declared_size.unwrap_or(s.content.len() as u64);
            let octal = format!("{size:011o}\0");
            header[124..136].copy_from_slice(&octal.as_bytes()[..12.min(octal.len())]);
            header[156] = s.typeflag;
            // ustar magic
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            out.extend_from_slice(&header);
            if s.typeflag == b'0' {
                out.extend_from_slice(s.content);
                let pad = (512 - (s.content.len() % 512)) % 512;
                out.extend(std::iter::repeat(0u8).take(pad));
            }
        }
        out.extend(std::iter::repeat(0u8).take(1024));
        out
    }

    #[test]
    fn parses_simple_file() {
        let tar = build_tar(&[spec("tex/latex/base/article.cls", b"hello")]);
        let entries = untar(&tar, None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "tex/latex/base/article.cls");
        assert_eq!(entries[0].entry_type, TarEntryType::File);
        assert_eq!(entries[0].content, b"hello");
    }

    #[test]
    fn rounds_to_512_blocks() {
        let big = vec![b'x'; 513];
        let tar = build_tar(&[spec("a.txt", &big), spec("b.txt", b"second")]);
        let entries = untar(&tar, None).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            ["a.txt", "b.txt"]
        );
        assert_eq!(entries[0].content.len(), 513);
        assert_eq!(entries[1].content, b"second");
    }

    #[test]
    fn dirs_are_marked_and_content_empty() {
        let tar = build_tar(&[
            Spec {
                path: "texmf/",
                content: b"",
                typeflag: b'5',
                declared_size: None,
            },
            spec("texmf/file.tex", b"ok"),
        ]);
        let entries = untar(&tar, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].entry_type, TarEntryType::Dir);
        assert!(entries[0].content.is_empty());
        assert_eq!(entries[1].entry_type, TarEntryType::File);
    }

    #[test]
    fn links_and_devices_are_other() {
        let mk = |p: &'static str, t: u8| Spec {
            path: p,
            content: b"",
            typeflag: t,
            declared_size: None,
        };
        let tar = build_tar(&[
            mk("texmf/link.sty", b'2'),
            mk("texmf/tty", b'3'),
            spec("texmf/real.sty", b"REAL"),
        ]);
        let entries = untar(&tar, None).unwrap();
        let files: Vec<&str> = entries
            .iter()
            .filter(|e| e.entry_type == TarEntryType::File)
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(files, ["texmf/real.sty"]);
        assert_eq!(
            entries
                .iter()
                .filter(|e| e.entry_type == TarEntryType::Other)
                .count(),
            2
        );
    }

    #[test]
    fn rejects_lying_header_size() {
        let tar = build_tar(&[Spec {
            path: "a.tex",
            content: b"short",
            typeflag: b'0',
            declared_size: Some(1024 * 1024),
        }]);
        let err = untar(&tar, None).unwrap_err();
        assert!(err.contains("past the end of the archive"), "{err}");
    }

    #[test]
    fn rejects_truncated_archive() {
        let full = build_tar(&[spec("a.tex", &vec![b'x'; 2000])]);
        let err = untar(&full[..1024], None).unwrap_err();
        assert!(err.contains("past the end of the archive"), "{err}");
    }

    #[test]
    fn enforces_entry_ceiling() {
        let specs: Vec<Spec<'_>> = (0..12)
            .map(|i| Spec {
                path: Box::leak(format!("f{i}.tex").into_boxed_str()),
                content: b"x",
                typeflag: b'0',
                declared_size: None,
            })
            .collect();
        let tar = build_tar(&specs);
        let err = untar(&tar, Some(10)).unwrap_err();
        assert!(err.contains("more than 10 entries"), "{err}");
        assert_eq!(untar(&tar, Some(12)).unwrap().len(), 12);
    }

    #[test]
    fn garbage_never_reads_out_of_bounds() {
        // Fuzz-ish: random bytes in tar-shaped blocks. A panic (OOB) would fail
        // the test process; an Err is acceptable.
        let mut rng: u32 = 0x2f6e2b1;
        let mut rand = move || {
            rng = rng.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fffffff;
            ((rng >> 8) & 0xff) as u8
        };
        for _ in 0..200 {
            let len = 512 * (1 + (rand() as usize % 4));
            let bytes: Vec<u8> = (0..len).map(|_| rand()).collect();
            if let Ok(entries) = untar(&bytes, None) {
                for e in entries {
                    // Whatever we report, content is owned/copied → always in bounds.
                    let _ = e.content.len();
                }
            }
        }
    }

    #[test]
    fn gzip_round_trip_and_bomb_limit() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let payload = b"gzip round trip payload";
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(payload).unwrap();
        let compressed = enc.finish().unwrap();
        assert_eq!(
            decompress(&compressed, CompressionFormat::Gzip, 1024).unwrap(),
            payload
        );

        let bomb_src = vec![0u8; 8 * 1024 * 1024];
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&bomb_src).unwrap();
        let bomb = enc.finish().unwrap();
        let err = decompress(&bomb, CompressionFormat::Gzip, 1024 * 1024).unwrap_err();
        assert!(err.contains("expands past"), "{err}");
        assert_eq!(
            decompress(&bomb, CompressionFormat::Gzip, 16 * 1024 * 1024)
                .unwrap()
                .len(),
            8 * 1024 * 1024
        );
    }
}
