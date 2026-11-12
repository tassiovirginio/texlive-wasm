/** Read a response with a ceiling enforced before buffering the entire body. */
export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid download limit');
  const declared = Number(response.headers?.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds the ${maxBytes}-byte download limit`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes)
      throw new Error(`Response exceeds the ${maxBytes}-byte download limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${maxBytes}-byte download limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
