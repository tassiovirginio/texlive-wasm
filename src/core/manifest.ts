import { fetchAsset } from './assets';
import { safeRelativePath } from './paths';

/**
 * tex-packages.json — content-addressed manifest of TL files.
 *
 * Generated at engine build time by `scripts/build-manifest.ts` by walking the
 * built TDS tree. Distributed alongside the engine artifacts.
 *
 * The runtime uses this for three things:
 *   1. Decide which backend tier should serve a given TDS path.
 *   2. Verify bytes before they reach the engine. What that covers, exactly:
 *      the core bundle is checked as a whole against `coreBundleSha256` before
 *      it is unpacked (vfs/bundlefs.ts), and every file served out of the OPFS
 *      cache or fetched from the CDN is checked against its `files[].sha256`
 *      (withIntegrity + FetchFsOptions.verify in vfs/index.ts). Files inside
 *      an already-verified bundle are NOT re-hashed one by one, and a file the
 *      manifest does not list is rejected by the verified cache/CDN layers. A
 *      backend the caller supplies itself (TauriFS, a custom `vfs` chain) is
 *      the caller's to verify; `withIntegrity()` is exported for that.
 *   3. Reverse-lookup which CTAN package a TDS file belongs to (used in error
 *      messages: "missing geometry.sty — try downloading the 'geometry' package").
 */

export type ManifestTier = 'core' | 'full' | 'cdn';

export interface ManifestEntry {
  /** SHA-256 of the file's bytes, hex. */
  sha256: string;
  /** File size in bytes. */
  size: number;
  /** Which delivery tier this file ships in. */
  tier: ManifestTier;
  /** CTAN package the file belongs to (best-effort; null for orphans). */
  package: string | null;
}

export interface TexPackagesManifest {
  /** Manifest format version. Bumped on schema changes. */
  schema: 1;
  /** Exact compatibility profile; engine year alone does not identify package versions. */
  environment?: { id: string; engines: string; tds: string };
  /** Versioned build identifier, e.g. "texlive-2026-r0". */
  version: string;
  /** When the manifest was built (ISO 8601). */
  generatedAt: string;
  /** Brotli-compressed core-tier bundle. */
  coreBundleUrl: string | null;
  /** SHA-256 of the core bundle's compressed bytes, hex. Optional (older manifests). */
  coreBundleSha256?: string | null;
  /** Brotli-compressed full-tier bundle (downloaded once on first run). */
  fullBundleUrl: string | null;
  /** SHA-256 of the full bundle's compressed bytes, hex. Optional (older manifests). */
  fullBundleSha256?: string | null;
  /** CDN base URL for per-file long-tail fetches. */
  cdnBaseUrl: string | null;
  /** TDS-relative path → entry. */
  files: Record<string, ManifestEntry>;
}

export async function loadManifest(
  url: string,
  signal?: AbortSignal,
): Promise<TexPackagesManifest> {
  const r = await fetchAsset(url, { cache: 'force-cache', ...(signal ? { signal } : {}) });
  if (!r.ok) {
    throw new Error(`Failed to load manifest from ${url}: HTTP ${r.status}`);
  }
  return validateManifest(await r.json());
}

/** Validate network JSON before treating it as a trusted runtime index. */
export function validateManifest(value: unknown): TexPackagesManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid manifest');
  const m = value as Record<string, unknown>;
  if (m.schema !== 1) throw new Error(`Unsupported manifest schema: ${m.schema}`);
  if (
    typeof m.version !== 'string' ||
    !m.version.trim() ||
    typeof m.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(m.generatedAt)) ||
    !m.files ||
    typeof m.files !== 'object' ||
    Array.isArray(m.files)
  ) {
    throw new Error('Invalid manifest metadata');
  }
  if (m.environment !== undefined) {
    const profile = m.environment as Record<string, unknown>;
    if (
      !profile ||
      typeof profile !== 'object' ||
      ['id', 'engines', 'tds'].some(
        (key) => typeof profile[key] !== 'string' || !(profile[key] as string).trim(),
      )
    )
      throw new Error('Invalid manifest environment');
  }
  for (const key of ['coreBundleUrl', 'fullBundleUrl', 'cdnBaseUrl']) {
    if (m[key] !== null && typeof m[key] !== 'string') throw new Error(`Invalid manifest ${key}`);
  }
  for (const key of ['coreBundleSha256', 'fullBundleSha256']) {
    if (
      m[key] != null &&
      (typeof m[key] !== 'string' || !/^[a-f0-9]{64}$/i.test(m[key] as string))
    ) {
      throw new Error(`Invalid manifest ${key}`);
    }
  }
  for (const [path, value] of Object.entries(m.files)) {
    const entry = value as ManifestEntry | null;
    if (
      safeRelativePath(path) !== path ||
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !['core', 'full', 'cdn'].includes(entry.tier) ||
      (entry.package !== null && typeof entry.package !== 'string')
    ) {
      throw new Error(`Invalid manifest file: ${path}`);
    }
  }
  return value as TexPackagesManifest;
}

export function tierOf(manifest: TexPackagesManifest, tdsPath: string): ManifestTier | null {
  return manifest.files[tdsPath]?.tier ?? null;
}

export function packageOf(manifest: TexPackagesManifest, tdsPath: string): string | null {
  return manifest.files[tdsPath]?.package ?? null;
}

export function expectedSha256(manifest: TexPackagesManifest, tdsPath: string): string | null {
  return manifest.files[tdsPath]?.sha256 ?? null;
}

/** SHA-256 of `bytes` as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Throw unless `bytes` hashes to `expected`. Used on whole blobs — the core
 * bundle, a CDN file — where a poisoned byte stream would otherwise be
 * executed as TeX macros or cached for every later session. Files served out
 * of a bundle we already verified are not re-hashed one by one.
 */
export async function assertSha256(
  bytes: Uint8Array,
  expected: string,
  what: string,
): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `texlive-wasm: integrity check failed for ${what}: expected sha256 ${expected}, got ${actual}`,
    );
  }
}
