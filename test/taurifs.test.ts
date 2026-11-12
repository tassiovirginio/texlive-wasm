/**
 * TauriFS is the one backend whose paths land on the user's real filesystem:
 * plugin-fs resolves them against a base dir with the app's own permissions.
 * A TDS path parsed out of an engine log must never reach it unconfined.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
const exists = vi.fn(async () => true);

vi.mock('@tauri-apps/plugin-fs', () => ({ readFile, exists }));

import { createTauriFs, withTauriFs, isTauri } from '../src/vfs/taurifs';

afterEach(() => {
  readFile.mockClear();
  exists.mockClear();
  vi.unstubAllGlobals();
});

const backend = () => createTauriFs({ texmfRoot: 'texmf', baseDir: 14 });

describe('createTauriFs', () => {
  it('reads a TDS path under the texmf root', async () => {
    const fs = await backend();
    expect(await fs.read('tex/latex/base/article.cls')).toEqual(new Uint8Array([1, 2, 3]));
    expect(readFile).toHaveBeenCalledWith('texmf/tex/latex/base/article.cls', { baseDir: 14 });
  });

  it('treats a leading slash as root-relative, not absolute', async () => {
    const fs = await backend();
    await fs.read('/tex/latex/base/article.cls');
    expect(readFile).toHaveBeenCalledWith('texmf/tex/latex/base/article.cls', { baseDir: 14 });
  });

  it('never hands plugin-fs a path that escapes the texmf root', async () => {
    const fs = await backend();
    for (const path of [
      '../../../etc/passwd',
      'tex/../../../.ssh/id_rsa',
      '..\\..\\Windows\\System32\\config\\SAM',
      'C:/Windows/System32/config/SAM',
    ]) {
      expect(await fs.read(path)).toBeNull();
      expect(await fs.exists!(path)).toBe(false);
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
});

it('reports missing resources as misses and reads existence under the same root', async () => {
  const fs = await backend();
  expect(await fs.exists!('a')).toBe(true);
  expect(exists).toHaveBeenCalledWith('texmf/a', { baseDir: 14 });
  readFile.mockRejectedValueOnce(new Error('missing'));
  exists.mockRejectedValueOnce(new Error('missing'));
  expect(await fs.read('a')).toBeNull();
  expect(await fs.exists!('a')).toBe(false);
});
it('requires Tauri and preserves extra backend ordering', async () => {
  expect(isTauri()).toBe(false);
  await expect(withTauriFs(vi.fn(), { texmfRoot: 'texmf', baseDir: 14 })).rejects.toThrow(
    'not running',
  );
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  const extra = { id: 'extra', read: () => null };
  const factory = vi.fn().mockResolvedValue({});
  await withTauriFs(factory, { texmfRoot: 'texmf', baseDir: 14, extraBackends: [extra] });
  expect(factory.mock.calls[0]![0].map((b: { id: string }) => b.id)).toEqual(['taurifs', 'extra']);
});
