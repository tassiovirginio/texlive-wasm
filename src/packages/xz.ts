import { readLimited } from '../core/download';
import { MAX_DECOMPRESSED_BYTES } from '../vfs/tar';
/** Lazy WASM decoder, usable offline in both browsers and Node. */
export async function decodePackageXz(
  bytes: Uint8Array,
  maxBytes = MAX_DECOMPRESSED_BYTES,
): Promise<Uint8Array> {
  const module = await import('xz-decompress');
  // Native Node ESM exposes this CommonJS dependency through default.
  const { XzReadableStream } = module.XzReadableStream
    ? module
    : (module as unknown as { default: typeof module }).default;
  const source = new Blob([new Uint8Array(bytes)]).stream();
  return readLimited(new Response(new XzReadableStream(source)), maxBytes);
}
