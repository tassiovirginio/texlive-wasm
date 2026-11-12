import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadManifest,
  tierOf,
  packageOf,
  expectedSha256,
  type TexPackagesManifest,
} from '../src/core/manifest';

const MANIFEST: TexPackagesManifest = {
  schema: 1,
  version: 'texlive-2026-r0',
  generatedAt: '2026-01-01T00:00:00Z',
  coreBundleUrl: 'core.tar.br',
  fullBundleUrl: null,
  cdnBaseUrl: null,
  files: {
    'tex/latex/base/article.cls': {
      sha256: 'ab'.repeat(32),
      size: 12,
      tier: 'core',
      package: 'base',
    },
    'tex/latex/geometry/geometry.sty': {
      sha256: 'cd'.repeat(32),
      size: 34,
      tier: 'cdn',
      package: 'geometry',
    },
  },
};

function stubFetch(response: Partial<Response> & { ok: boolean }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadManifest', () => {
  it('parses a valid manifest', async () => {
    stubFetch({ ok: true, json: () => Promise.resolve(MANIFEST) } as unknown as Response);
    const m = await loadManifest('https://example.test/tex-packages.json');
    expect(m.version).toBe('texlive-2026-r0');
    expect(Object.keys(m.files)).toHaveLength(2);
  });

  it('throws on HTTP errors', async () => {
    stubFetch({ ok: false, status: 404 } as unknown as Response);
    await expect(loadManifest('https://example.test/missing.json')).rejects.toThrow('HTTP 404');
  });

  it('rejects unknown schema versions', async () => {
    stubFetch({
      ok: true,
      json: () => Promise.resolve({ ...MANIFEST, schema: 2 }),
    } as unknown as Response);
    await expect(loadManifest('https://example.test/m.json')).rejects.toThrow(
      'Unsupported manifest schema',
    );
  });
});

describe('manifest lookups', () => {
  it('tierOf / packageOf / expectedSha256 resolve known paths', () => {
    expect(tierOf(MANIFEST, 'tex/latex/base/article.cls')).toBe('core');
    expect(packageOf(MANIFEST, 'tex/latex/geometry/geometry.sty')).toBe('geometry');
    expect(expectedSha256(MANIFEST, 'tex/latex/base/article.cls')).toBe('ab'.repeat(32));
  });

  it('returns null for unknown paths', () => {
    expect(tierOf(MANIFEST, 'nope')).toBeNull();
    expect(packageOf(MANIFEST, 'nope')).toBeNull();
    expect(expectedSha256(MANIFEST, 'nope')).toBeNull();
  });
});

describe('manifest validation', () => {
  it.each([
    null,
    [],
    { ...MANIFEST, files: [] },
    { ...MANIFEST, version: '' },
    { ...MANIFEST, generatedAt: 'yesterday' },
    { ...MANIFEST, coreBundleSha256: 'bad' },
    { ...MANIFEST, files: { '../escape': MANIFEST.files['tex/latex/base/article.cls'] } },
    { ...MANIFEST, files: { a: { sha256: 'a'.repeat(64), size: -1, tier: 'cdn', package: null } } },
  ])('rejects malformed network JSON (%#)', async (value) => {
    stubFetch({ ok: true, json: async () => value });
    await expect(loadManifest('https://test/manifest')).rejects.toThrow();
  });
});
