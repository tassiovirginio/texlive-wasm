import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchFs } from '../src/vfs/fetchfs';
afterEach(() => vi.unstubAllGlobals());
describe('FetchFS', () => {
  it('encodes segments, rejects escaping paths and returns missing on 404', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const fs = createFetchFs({ cdnBaseUrl: 'https://test/base' });
    expect(await fs.read('../escape')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await fs.read('tex/a b.sty')).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://test/base/tex/a%20b.sty');
  });
  it('verifies bytes before persisting them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('trusted'))),
    );
    const persist = vi.fn();
    const denied = createFetchFs({
      cdnBaseUrl: 'https://test/',
      verify: () => false,
      onFetched: persist,
    });
    expect(await denied.read('a')).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    const allowed = createFetchFs({
      cdnBaseUrl: 'https://test/',
      verify: () => true,
      onFetched: persist,
    });
    expect(new TextDecoder().decode((await allowed.read('a'))!)).toBe('trusted');
    expect(persist).toHaveBeenCalledOnce();
  });
  it('surfaces server errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(createFetchFs({ cdnBaseUrl: 'https://test' }).read('a')).rejects.toThrow('503');
  });
});
