import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { buildTar } from './helpers';
const { extractTarGz } = createRequire(import.meta.url)('../scripts/lib/archive.cjs') as {
  extractTarGz: (
    b: Uint8Array,
    dest: string,
    options?: { maxBytes?: number; maxEntries?: number },
  ) => Promise<void>;
};
let roots: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'cli-archive-'));
  roots.push(p);
  return p;
};
afterEach(() => {
  roots.forEach((p) => rmSync(p, { recursive: true, force: true }));
  roots = [];
});
describe('CLI archive extraction', () => {
  it('extracts nested regular files', async () => {
    const root = temp();
    await extractTarGz(gzipSync(buildTar([{ path: 'engine/test.js', content: 'ok' }])), root);
    expect(readFileSync(join(root, 'engine/test.js'), 'utf8')).toBe('ok');
  });
  it.each(['../escape', '/tmp/escape', 'a/../../escape'])(
    'rejects escaping path %s before writing other entries',
    async (path) => {
      const root = temp();
      await expect(
        extractTarGz(
          gzipSync(
            buildTar([
              { path: 'safe', content: 'x' },
              { path, content: 'bad' },
            ]),
          ),
          root,
        ),
      ).rejects.toThrow();
      expect(existsSync(join(root, 'safe'))).toBe(false);
    },
  );
  it('rejects preexisting symlinks', async () => {
    const root = temp();
    const outside = temp();
    symlinkSync(outside, join(root, 'redirect'));
    await expect(
      extractTarGz(gzipSync(buildTar([{ path: 'redirect/file', content: 'bad' }])), root),
    ).rejects.toThrow('symlink');
    expect(existsSync(join(outside, 'file'))).toBe(false);
  });
  it('rejects corrupt headers, truncated payloads, links and duplicate entries', async () => {
    for (const tar of [
      buildTar([{ path: 'x', content: 'a', declaredSize: 999999 }]),
      buildTar([{ path: 'x', type: 'symlink' }]),
      buildTar([{ path: 'x' }, { path: 'x' }]),
      new Uint8Array(512).fill(1),
    ])
      await expect(extractTarGz(gzipSync(tar), temp())).rejects.toThrow();
  });
  it('limits decompressed size and entry count', async () => {
    const gz = gzipSync(
      buildTar([
        { path: 'a', content: 'x' },
        { path: 'b', content: 'y' },
      ]),
    );
    await expect(extractTarGz(gz, temp(), { maxBytes: 32 })).rejects.toThrow();
    await expect(extractTarGz(gz, temp(), { maxEntries: 1 })).rejects.toThrow('entry limit');
  });
});
