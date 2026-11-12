import { describe, expect, it, vi } from 'vitest';
import { readLimited } from '../src/core/download';

describe('bounded downloads', () => {
  it('rejects a declared oversized body without reading it', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': '100' },
    });
    await expect(readLimited(response, 4)).rejects.toThrow('download limit');
    expect(cancel).toHaveBeenCalled();
  });
  it('cancels an oversized chunked body even when the server understates its size', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(3));
        },
        cancel,
      }),
      { headers: { 'content-length': '1' } },
    );
    await expect(readLimited(response, 4)).rejects.toThrow('download limit');
    expect(cancel).toHaveBeenCalled();
  });
  it('assembles multiple chunks up to the limit', async () => {
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3]));
          c.close();
        },
      }),
    );
    expect(await readLimited(response, 3)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('rejects invalid limits', async () => {
    await expect(readLimited(new Response('x'), NaN)).rejects.toThrow('Invalid download limit');
  });
});
