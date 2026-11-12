/**
 * OPFS-backed VFS — persistent cache for the "full" tier and CDN fetches.
 *
 * Browser layout under the OPFS root:
 *   texlive-wasm/
 *     <manifest version>/      (see `version` — caches never span TL builds)
 *       full/                  (unpacked full-tier bundle)
 *         tex/latex/base/article.cls
 *         ...
 *       cdn/                   (cached long-tail fetches, written through
 *                               from FetchFS via OpfsBackend.write())
 *         tex/latex/some-rare/rare.sty
 */

import type { VfsBackend } from '../core/types';
import { safeRelativePath } from '../core/paths';

export interface OpfsFsOptions {
  /** Root directory name within OPFS. Default: "texlive-wasm". */
  rootName?: string;
  /**
   * Namespace the cache by the TL build it belongs to (the manifest's
   * `version`). Files cached for one build are not valid for another — and an
   * unversioned cache is a place for one document's poisoned download to
   * outlive it. Default: "unversioned", which keeps pre-existing caches
   * readable.
   */
  version?: string;
}

/** VfsBackend plus the write-through hook FetchFS feeds (see vfs/index.ts). */
export interface OpfsBackend extends VfsBackend {
  /** Persist a fetched file into the cdn/ cache tier. Failures are swallowed. */
  write(tdsPath: string, bytes: Uint8Array): Promise<void>;
}

export async function createOpfsFs(opts: OpfsFsOptions = {}): Promise<OpfsBackend> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('texlive-wasm: OPFS is not available in this browser context');
  }
  const rootName = opts.rootName ?? 'texlive-wasm';
  const version = opts.version ?? 'unversioned';
  const root = await navigator.storage.getDirectory();
  // Ensure the top-level dirs exist.
  const tlRoot = await root.getDirectoryHandle(rootName, { create: true });
  const versionRoot = await tlRoot.getDirectoryHandle(safeSegment(version), { create: true });
  const fullDir = await versionRoot.getDirectoryHandle('full', { create: true });
  const cdnDir = await versionRoot.getDirectoryHandle('cdn', { create: true });

  async function walkTo(
    dir: FileSystemDirectoryHandle,
    tdsPath: string,
    create: boolean,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const safe = safeRelativePath(tdsPath);
    if (!safe) return null;
    const parts = safe.split('/');
    let cur: FileSystemDirectoryHandle = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        cur = await cur.getDirectoryHandle(parts[i]!, { create });
      } catch {
        return null;
      }
    }
    return { dir: cur, name: parts[parts.length - 1]! };
  }

  async function readFrom(
    dir: FileSystemDirectoryHandle,
    tdsPath: string,
  ): Promise<Uint8Array | null> {
    const loc = await walkTo(dir, tdsPath, false);
    if (!loc) return null;
    try {
      const fh = await loc.dir.getFileHandle(loc.name, { create: false });
      const file = await fh.getFile();
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    } catch {
      return null;
    }
  }

  return {
    id: 'opfsfs',
    async read(tdsPath: string): Promise<Uint8Array | null> {
      // Check "full" first (preloaded full bundle), then the "cdn" cache.
      return (await readFrom(fullDir, tdsPath)) ?? (await readFrom(cdnDir, tdsPath));
    },
    async write(tdsPath: string, bytes: Uint8Array): Promise<void> {
      try {
        const loc = await walkTo(cdnDir, tdsPath, true);
        if (!loc) return;
        const fh = await loc.dir.getFileHandle(loc.name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(bytes as unknown as ArrayBufferView<ArrayBuffer>);
        await writable.close();
      } catch {
        // Cache write-through is best-effort; a full or unavailable OPFS
        // must not fail the read that triggered it.
      }
    },
  };
}

/** A manifest version reaches us as a string; it must stay one path segment. */
function safeSegment(name: string): string {
  return name.replace(/[^\w.-]+/g, '_') || 'unversioned';
}
