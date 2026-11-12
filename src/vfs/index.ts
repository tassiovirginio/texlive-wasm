/**
 * VFS layer chain — defaults and helpers.
 *
 * The layer chain is consulted in order on every read; the first non-null
 * answer wins. This lets us put the cheapest backends first (BundleFS, then
 * cached layers, then network).
 */

import type { EngineConfig, EngineId, VfsBackend } from '../core/types';
import type { TexPackagesManifest } from '../core/manifest';
import { expectedSha256, loadManifest, sha256Hex } from '../core/manifest';
import { createBundleFs } from './bundlefs';
import { createOpfsFs } from './opfsfs';
import { createFetchFs } from './fetchfs';

export interface DefaultBackendsOptions {
  /**
   * Leave the manifest's core bundle out of the chain. createEngine() sets
   * this when the engine runs in a worker: the worker builds the BundleFS
   * itself, so the tree is unpacked once, on the side that actually needs it.
   */
  skipManifestBundle?: boolean;
}

/**
 * Build the default backend chain for an engine instance.
 *
 * Order: BundleFS (in-memory core) → OPFS (when in a browser/PWA) → FETCHFS (CDN fallback).
 *
 * The TauriFS backend is *not* installed by default — the consumer opts in via
 * `withTauriFs(...)` from the `texlive-wasm/tauri` entry. That keeps web
 * consumers from picking up a hard dep on @tauri-apps/plugin-fs.
 */
export async function defaultBackends(
  _id: EngineId,
  config: EngineConfig,
  options: DefaultBackendsOptions = {},
): Promise<VfsBackend[]> {
  const layers: VfsBackend[] = [];

  // The manifest carries the per-file digests the cache and CDN tiers are
  // checked against, so it is loaded whenever one of them is in play. A
  // manifest we cannot read is not fatal — it costs verification, not
  // function — but it is worth saying out loud.
  let manifest: TexPackagesManifest | null = null;
  if (config.manifestUrl) {
    try {
      manifest = await loadManifest(config.manifestUrl, config.initSignal);
    } catch (err) {
      console.warn(
        `texlive-wasm: could not load manifest ${config.manifestUrl} (${String(err)}); ` +
          `unverified cache/CDN reads require allowUnverifiedAssets`,
      );
    }
  }

  const allowUnverified = config.allowUnverifiedAssets === true;

  // A CDN tier with no manifest to check it against hands the engine whatever
  // the network returns. That is a deployment mistake, not a runtime mode.
  if (config.cdnBaseUrl && !manifest && !allowUnverified) {
    throw new Error(
      `texlive-wasm: cdnBaseUrl is set but no manifest could be loaded, so CDN files cannot be ` +
        `integrity-checked. Set manifestUrl (its per-file sha256 is what verifies them), or set ` +
        `allowUnverifiedAssets: true for development.`,
    );
  }

  // BundleFS when a manifest names a core bundle — keeps the engine from
  // immediately falling through to the network on every read.
  if (config.manifestUrl && !options.skipManifestBundle) {
    layers.push(await createBundleFs({ manifestUrl: config.manifestUrl, allowUnverified }));
  }

  let opfs: Awaited<ReturnType<typeof createOpfsFs>> | null = null;
  if (isOpfsAvailable()) {
    try {
      opfs = await createOpfsFs(manifest ? { version: manifest.version } : {});
    } catch {
      console.warn('texlive-wasm: OPFS unavailable; continuing without persistent cache');
    }
    // A persistent cache is exactly what an attacker wants to poison: verify
    // on the way out, so one bad write cannot serve a bad file forever.
    if (opfs && manifest) layers.push(withIntegrity(opfs, manifest));
    else if (opfs && allowUnverified) layers.push(opfs);
  }

  if (config.cdnBaseUrl) {
    const cache = opfs;
    const index = manifest;
    layers.push(
      createFetchFs({
        cdnBaseUrl: config.cdnBaseUrl,
        // Write-through: CDN hits are persisted into the OPFS cdn/ tier so
        // the next session reads them locally.
        ...(cache
          ? { onFetched: (tdsPath: string, bytes: Uint8Array) => cache.write(tdsPath, bytes) }
          : {}),
        // Verified BEFORE the write-through fires, or a poisoned response
        // would be the thing we cache.
        ...(index
          ? { verify: (tdsPath: string, bytes: Uint8Array) => matches(index, tdsPath, bytes) }
          : {}),
      }),
    );
  }

  return layers;
}

/**
 * Wrap a backend so every file it serves must hash to what the manifest says.
 * A mismatch is reported as a miss (the next tier answers, or the engine
 * reports the file missing) — never as bytes the engine will interpret.
 *
 * Files the manifest does not list are rejected. Custom unverified backends
 * can be mounted explicitly without this wrapper.
 */
export function withIntegrity(backend: VfsBackend, manifest: TexPackagesManifest): VfsBackend {
  const wrapped: VfsBackend = {
    id: backend.id,
    async read(tdsPath: string): Promise<Uint8Array | null> {
      const bytes = await backend.read(tdsPath);
      if (!bytes) return null;
      return (await matches(manifest, tdsPath, bytes)) ? bytes : null;
    },
  };
  if (backend.exists) wrapped.exists = async (p: string) => (await wrapped.read(p)) !== null;
  if (backend.list) wrapped.list = (p: string) => backend.list!(p);
  if (backend.init) wrapped.init = () => backend.init!();
  if (backend.dispose) wrapped.dispose = () => backend.dispose!();
  return wrapped;
}

async function matches(
  manifest: TexPackagesManifest,
  tdsPath: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const expected = expectedSha256(manifest, tdsPath.replace(/^\/+/, ''));
  if (!expected) return false;
  const actual = await sha256Hex(bytes);
  if (actual === expected.toLowerCase()) return true;
  console.warn(
    `texlive-wasm: integrity check failed for ${tdsPath} (expected ${expected}, got ${actual}); ` +
      `discarding those bytes`,
  );
  return false;
}

function isOpfsAvailable(): boolean {
  // OPFS lives on navigator.storage.getDirectory(), available in workers.
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

export { createBundleFs } from './bundlefs';
export { createOpfsFs } from './opfsfs';
export { createFetchFs } from './fetchfs';
export { createTauriFs, isTauri, withTauriFs } from './taurifs';
export type { TauriFsOptions } from './taurifs';
