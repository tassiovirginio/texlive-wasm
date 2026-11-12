import { decompress } from '../vfs/tar';

/**
 * Minimal gzip decompression helpers.
 *
 * Browsers ≥2023 and Node ≥18 have DecompressionStream natively, which is all
 * we need for `.synctex.gz`. If perf matters later we can swap in fflate
 * (~3KB extra) and use its synchronous decompressSync for tiny blobs.
 */

export function strFromU8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Async gzip decompress via the platform DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return decompress(bytes, 'gzip', 64 * 1024 * 1024);
}
