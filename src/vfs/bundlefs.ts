import { fetchAsset } from '../core/assets';
/**
 * BundleFS — serves a TL TDS subset that was preloaded into memory.
 *
 * The bundle is a gzip- or brotli-wrapped tar of `texmf-dist/*` paths. On
 * engine init we fetch it once, decompress via native DecompressionStream,
 * untar into a Map, and serve reads from RAM.
 *
 * - `bundleUrl` is fetched as bytes; the format ('gzip'/'br') is auto-detected
 *   from the URL extension or magic bytes.
 * - `manifestUrl` alone also works: the manifest's `coreBundleUrl` (resolved
 *   relative to the manifest) names the bundle to fetch.
 * - For Node/Tauri tests, callers can pass `bundleBytes` directly.
 */

import type { VfsBackend } from '../core/types';
import { assertSha256, loadManifest } from '../core/manifest';
import { safeRelativePath } from '../core/paths';
import { decompress, untar, MAX_DECOMPRESSED_BYTES } from './tar';
import { readLimited } from '../core/download';

export interface BundleFsOptions {
  /** Manifest URL; its `coreBundleUrl` locates the bundle when `bundleUrl` is not given. */
  manifestUrl?: string;
  /** Explicit bundle URL override. */
  bundleUrl?: string;
  /** Pre-loaded bundle bytes (skip fetch). Useful for tests + Tauri resources. */
  bundleBytes?: Uint8Array;
  /**
   * SHA-256 (hex) the fetched bundle must hash to. When the bundle comes from
   * a manifest, its `coreBundleSha256` is used automatically.
   */
  sha256?: string;
  /**
   * Fetch a bundle for which no SHA-256 is known. Off by default: a bundle is
   * the whole TeX tree the engine will execute, and a cross-origin one that
   * nothing pins is a supply-chain hole. Same-origin bundles (the app serving
   * its own assets) are exempt — they carry the same trust as the code doing
   * the fetching. Turn this on only in development.
   */
  allowUnverified?: boolean;
  /**
   * Compression format. Default: auto-detect from bundleUrl suffix (`.gz`
   * / `.br`) or via magic-byte sniff on the bytes.
   */
  format?: 'gzip' | 'br';
  /**
   * Strip a leading path prefix from every entry. Default: `'texmf/'` (the
   * bundle produced by `scripts/pack-tds.mjs` nests everything under that).
   */
  stripPrefix?: string;
  /** Ceiling on the decompressed archive. Default: tar.ts's MAX_DECOMPRESSED_BYTES. */
  maxBytes?: number;
  /** Ceiling on the compressed download. Default: MAX_COMPRESSED_BYTES. */
  maxCompressedBytes?: number;
}

/**
 * Ceiling on the bundle we are willing to download. The full TDS bundle is
 * ~120 MB compressed; twice that is already not a bundle we published.
 */
export const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;

export async function createBundleFs(opts: BundleFsOptions): Promise<VfsBackend> {
  const files = new Map<string, Uint8Array>();
  const stripPrefix = opts.stripPrefix ?? 'texmf/';

  async function load(): Promise<void> {
    let bytes = opts.bundleBytes;
    let bundleUrl = opts.bundleUrl;
    let expectedSha = opts.sha256;
    if (!bytes && !bundleUrl && opts.manifestUrl) {
      const manifest = await loadManifest(opts.manifestUrl);
      if (manifest.coreBundleUrl) {
        bundleUrl = new URL(manifest.coreBundleUrl, absolutize(opts.manifestUrl)).toString();
        expectedSha ??= manifest.coreBundleSha256 ?? undefined;
      }
    }
    if (!bytes && bundleUrl) {
      requireIntegrity(bundleUrl, expectedSha, opts.allowUnverified === true);
      const r = await fetchAsset(bundleUrl);
      if (!r.ok) throw new Error(`BundleFs: HTTP ${r.status} for ${bundleUrl}`);
      bytes = await readLimited(r, opts.maxCompressedBytes ?? MAX_COMPRESSED_BYTES);
    }
    if (!bytes) return;
    // Verify the compressed blob before unpacking it: everything in here —
    // packages, formats, ls-R — is fed straight to the engine, so a poisoned
    // bundle is arbitrary TeX. Verifying once beats hashing 17k files.
    if (expectedSha) {
      await assertSha256(bytes, expectedSha, bundleUrl ?? 'bundle');
    }
    const format = opts.format ?? detectFormat(bundleUrl, bytes);
    if (!format) {
      throw new Error(
        `BundleFs: cannot tell what ${bundleUrl ?? 'the supplied bundle'} is compressed with — ` +
          `it is neither gzip nor a plain tar. Brotli has no magic bytes, so name the file ` +
          `.tar.br or pass format: 'br' explicitly.`,
      );
    }
    if (bytes.length > (opts.maxCompressedBytes ?? MAX_COMPRESSED_BYTES)) {
      throw new Error('BundleFs: compressed bytes exceed download limit');
    }
    if (format === 'raw' && bytes.length > (opts.maxBytes ?? MAX_DECOMPRESSED_BYTES)) {
      throw new Error('BundleFs: tar exceeds decompressed limit');
    }
    const tar = format === 'raw' ? bytes : await decompress(bytes, format, opts.maxBytes);
    let rejected = 0;
    let firstRejected = '';
    let duplicates = 0;
    for (const entry of untar(tar)) {
      if (entry.type !== 'file') continue;
      let path = entry.path;
      if (path.startsWith(stripPrefix)) path = path.slice(stripPrefix.length);
      // Tar entry names are attacker-controlled if the bundle is. A `..`
      // segment climbs out of the tree; an absolute name is not something tar
      // produces (it strips the leading slash on create), so treat it as the
      // red flag it is rather than quietly reinterpreting it as relative.
      const safe = path.startsWith('/') ? null : safeRelativePath(path);
      if (!safe) {
        rejected++;
        firstRejected ||= entry.path;
        continue;
      }
      // A second entry for the same name is how an archive says one thing to
      // whatever inspected it and another to whoever unpacks it last. First
      // one wins; the shadowing copy is dropped.
      if (files.has(safe)) {
        duplicates++;
        continue;
      }
      files.set(safe, entry.content);
    }
    if (rejected > 0) {
      console.warn(
        `texlive-wasm: BundleFs dropped ${rejected} archive entr${rejected === 1 ? 'y' : 'ies'} ` +
          `with an escaping path (first: ${firstRejected}) from ${bundleUrl ?? 'the supplied bundle'}`,
      );
    }
    if (duplicates > 0) {
      console.warn(
        `texlive-wasm: BundleFs dropped ${duplicates} duplicate archive entr` +
          `${duplicates === 1 ? 'y' : 'ies'} from ${bundleUrl ?? 'the supplied bundle'}; ` +
          `the first copy of each name is the one served`,
      );
    }
  }

  return {
    id: 'bundlefs',
    read(tdsPath: string): Uint8Array | null {
      return files.get(stripLeading(tdsPath)) ?? null;
    },
    exists(tdsPath: string): boolean {
      return files.has(stripLeading(tdsPath));
    },
    list(prefix: string): string[] {
      const p = stripLeading(prefix);
      const out: string[] = [];
      for (const path of files.keys()) {
        if (path.startsWith(p)) out.push(path);
      }
      return out;
    },
    async init() {
      await load();
    },
  };
}

function stripLeading(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * A bundle we fetch is the entire TeX tree the engine executes — its formats,
 * its config, every package a document can \input. Bytes for it must be
 * pinned by a digest unless they come from our own origin, where tampering
 * with them already means tampering with the app.
 */
function requireIntegrity(bundleUrl: string, sha256: string | undefined, allow: boolean): void {
  if (
    sha256 ||
    allow ||
    isSameOrigin(bundleUrl) ||
    (bundleUrl.startsWith('file:') && typeof process !== 'undefined' && !!process.versions?.node)
  )
    return;
  throw new Error(
    `BundleFs: refusing to load ${bundleUrl} — no SHA-256 for it. Publish the digest in the ` +
      `manifest (coreBundleSha256), pass it as \`sha256\`, or serve the bundle from the app's ` +
      `own origin. For development only, set allowUnverified/allowUnverifiedAssets.`,
  );
}

/**
 * Same origin as the code doing the fetching — i.e. the worker's own origin.
 *
 * Tauri's asset protocol is NOT exempt: `convertFileSrc()` hands back an
 * `asset://localhost` / `http://asset.localhost` URL, whose origin is not the
 * page's, so a bundle addressed that way must still be pinned with `sha256`
 * (or read off disk and passed as `bundleBytes`, which skips fetching).
 */
function isSameOrigin(url: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** Make a possibly-relative manifest URL absolute so it can be a URL base. */
function absolutize(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const origin = typeof location !== 'undefined' ? location.href : 'file:///';
  return new URL(url, origin).toString();
}

/**
 * Identify the bundle's compression, or null when nothing identifies it.
 *
 * Brotli has no magic bytes, so it can only be asserted (by the `.tar.br`
 * suffix or an explicit `format`) — never inferred. Guessing 'br' for
 * "anything else" fed every unrecognized byte stream, including an HTML error
 * page a proxy substituted for the bundle, into DecompressionStream('br').
 */
export function detectFormat(
  url: string | undefined,
  bytes: Uint8Array,
): 'gzip' | 'br' | 'raw' | null {
  if (url) {
    // Query strings and fragments are legal on an asset URL.
    const path = url.split(/[?#]/)[0] ?? url;
    if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return 'gzip';
    if (path.endsWith('.tar.br')) return 'br';
    if (path.endsWith('.tar')) return 'raw';
  }
  // gzip has magic bytes 1F 8B.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  // A plain tar has "ustar" at offset 257 of the first header block.
  if (
    bytes.length >= 262 &&
    bytes[257] === 0x75 && // u
    bytes[258] === 0x73 && // s
    bytes[259] === 0x74 && // t
    bytes[260] === 0x61 && // a
    bytes[261] === 0x72 // r
  ) {
    return 'raw';
  }
  return null;
}
