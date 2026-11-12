import { it, expect } from 'vitest';
import { InputBlobCache } from '../src/core/blobs';
import { sha256Hex } from '../src/core/manifest';
const bytes = (s: string) => new TextEncoder().encode(s);
it('reuses immutable blobs, applies deletions by complete manifests and verifies integrity', async () => {
  const cache = new InputBlobCache(10);
  const content = bytes('AAAA');
  const hash = await sha256Hex(content);
  let r = await cache.receive([{ path: 'image.png', sha256: hash }], [{ sha256: hash, content }]);
  expect(r.sentBytes).toBe(4);
  r = await cache.receive([{ path: 'renamed.png', sha256: hash }], []);
  expect(r.reusedBytes).toBe(4);
  expect(r.files.map((f) => f.path)).toEqual(['renamed.png']);
  expect((await cache.receive([], [])).files).toEqual([]);
  await expect(cache.receive([{ path: '../bad', sha256: hash }], [])).rejects.toThrow('path');
  await expect(cache.receive([{ path: 'a', sha256: 'missing' }], [])).rejects.toThrow('Missing');
  await expect(cache.receive([], [{ sha256: hash, content: bytes('BBBB') }])).rejects.toThrow(
    'integrity',
  );
  cache.clear();
  expect(cache.keys()).toEqual([]);
  expect(() => new InputBlobCache(-1)).toThrow('Invalid');
});
it('evicts LRU entries without losing requested files and skips oversized blobs', async () => {
  const cache = new InputBlobCache(5);
  const a = bytes('aaaa'),
    b = bytes('bbbb'),
    h1 = await sha256Hex(a),
    h2 = await sha256Hex(b);
  await cache.receive([{ path: 'a', sha256: h1 }], [{ sha256: h1, content: a }]);
  const r = await cache.receive(
    [
      { path: 'b', sha256: h2 },
      { path: 'a', sha256: h1 },
    ],
    [{ sha256: h2, content: b }],
  );
  expect(r.files).toHaveLength(2);
  expect(cache.keys()).toEqual([h1]);
  const off = new InputBlobCache(0);
  await off.receive([{ path: 'a', sha256: h1 }], [{ sha256: h1, content: a }]);
  expect(off.keys()).toEqual([]);
  await expect(
    cache.receive(
      [
        { path: 'a', sha256: h1 },
        { path: 'a', sha256: h1 },
      ],
      [],
    ),
  ).rejects.toThrow('duplicate');
});
