import { afterEach, describe, it, expect, vi } from 'vitest';
import { withIntegrity, defaultBackends } from '../src/vfs';
import { sha256Hex, type TexPackagesManifest } from '../src/core/manifest';

const bytes = new TextEncoder().encode('trusted');
const manifest: TexPackagesManifest = {
  schema: 1,
  version: '1',
  generatedAt: '2026-01-01',
  coreBundleUrl: null,
  fullBundleUrl: null,
  cdnBaseUrl: null,
  files: {},
};
afterEach(() => vi.unstubAllGlobals());
describe('verified cache and CDN', () => {
  it('allows known matching content and rejects mismatches and unknown files', async () => {
    const index = {
      ...manifest,
      files: {
        known: {
          sha256: await sha256Hex(bytes),
          size: bytes.length,
          tier: 'cdn' as const,
          package: null,
        },
      },
    };
    const cache = withIntegrity(
      { id: 'cache', read: (p) => (p === 'bad' ? new Uint8Array([0]) : bytes), exists: () => true },
      index,
    );
    expect(await cache.read('known')).toEqual(bytes);
    expect(await cache.read('unknown')).toBeNull();
    expect(await cache.exists!('unknown')).toBe(false);
    const corrupt = withIntegrity({ id: 'cache', read: () => new Uint8Array([0]) }, index);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await corrupt.read('known')).toBeNull();
    vi.restoreAllMocks();
  });
  it('refuses an unverified CDN by default', async () => {
    await expect(defaultBackends('pdflatex', { cdnBaseUrl: 'https://test' })).rejects.toThrow(
      'no manifest',
    );
  });
});

it('falls back gracefully when browser policy denies OPFS', async () => {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => {
        throw new Error('denied');
      },
    },
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await defaultBackends('pdflatex', {})).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('OPFS unavailable'));
  warn.mockRestore();
});
