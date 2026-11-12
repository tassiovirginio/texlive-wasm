import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAsset } from '../src/core/assets';
afterEach(() => vi.unstubAllGlobals());
it('reads explicitly configured Node file URLs and reports missing local assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tex-assets-'));
  try {
    const path = join(root, 'asset');
    await writeFile(path, 'bytes');
    expect(await (await fetchAsset(pathToFileURL(path).href)).text()).toBe('bytes');
    await expect(fetchAsset(pathToFileURL(join(root, 'missing')).href)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchAsset(pathToFileURL(path).href, { signal: controller.signal }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('forwards network options and cancellation signals', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('x'));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await fetchAsset('https://test', { signal: controller.signal });
  expect(fetch).toHaveBeenCalledWith('https://test', { signal: controller.signal });
});
