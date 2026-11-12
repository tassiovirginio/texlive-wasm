import { it, expect, vi } from 'vitest';
import { parseTlpdb, packagesForFile, createPackageFs } from '../src/packages';
import { sha256Hex } from '../src/core/manifest';
import { buildTar } from './helpers';
import { gzipSync } from 'node:zlib';
it('indexes runfiles, retains paths and resolves exact/case/extension names', () => {
  const index = parseTlpdb(
    'name lm\nrevision 1\ncontainerchecksum abc\nrunfiles size=1\n texmf-dist/tex/latex/lm/lmodern.sty\n texmf-dist/fonts/opentype/lm/Font.otf\ndocfiles size=1\n texmf-dist/doc/manual.tex\nname invalid.arch\nrunfiles size=1\n RELOC/tex/bad.sty',
    '2023',
  );
  expect(packagesForFile(index, 'LMODERN')).toEqual(['lm']);
  expect(packagesForFile(index, 'Font')).toEqual(['lm']);
  expect(index.packages.lm!.files).toHaveLength(2);
  expect(packagesForFile(index, '../.hidden')).toEqual([]);
  expect(packagesForFile(index, 'absent')).toEqual([]);
});
it('verifies archives, preserves auxiliary bib/images and caches complete packages', async () => {
  const raw = buildTar([
    { path: 'RELOC/tex/latex/pkg/pkg.sty', content: 'STYLE' },
    { path: 'RELOC/bibtex/bib/pkg/pkg-options.bib', content: 'OPTIONS' },
    { path: 'RELOC/tex/latex/pkg/icon.pdf', content: 'PDF' },
    { path: 'RELOC/../evil', content: 'BAD' },
  ]);
  const bytes = new Uint8Array(gzipSync(raw));
  const sum = await sha256Hex(bytes);
  const index = parseTlpdb(
    `name pkg\nrevision 1\ncontainerchecksum ${sum}\nrunfiles size=1\n RELOC/tex/latex/pkg/pkg.sty\n RELOC/bibtex/bib/pkg/pkg-options.bib\n RELOC/tex/latex/pkg/icon.pdf`,
    '2023',
  );
  const cache = new Map<string, Uint8Array>();
  const fetchPackage = vi.fn(async () => ({ bytes, format: 'gzip' as const }));
  const opts = {
    index,
    version: '2023',
    fetchPackage,
    cache: {
      get: async (k: string) => cache.get(k) ?? null,
      put: async (k: string, v: Uint8Array) => {
        cache.set(k, v);
      },
    },
  };
  const fs = createPackageFs(opts);
  expect((await fs.resolve!('pkg.sty')).map((f) => f.path)).toContain(
    'bibtex/bib/pkg/pkg-options.bib',
  );
  expect(await fs.read('evil')).toBeNull();
  expect(await fs.read('tex/latex/pkg/pkg.sty')).toBeTruthy();
  const other = createPackageFs(opts);
  await other.resolve!('pkg.sty');
  expect(fetchPackage).toHaveBeenCalledTimes(1);
  await fs.dispose!();
  expect(() => createPackageFs({ ...opts, version: '2026' })).toThrow('version mismatch');
});
it('rejects corruption and retries a transient provider failure', async () => {
  const raw = buildTar([{ path: 'RELOC/tex/latex/a.sty', content: 'A' }]);
  const sum = await sha256Hex(raw);
  const index = parseTlpdb(
    `name a\ncontainerchecksum ${sum}\nrunfiles n=1\n RELOC/tex/latex/a.sty`,
    'v',
  );
  let fail = true;
  const fs = createPackageFs({
    index,
    version: 'v',
    fetchPackage: async () => {
      if (fail) throw Error('offline');
      return { bytes: raw, format: 'tar' };
    },
  });
  await expect(fs.resolve!('a.sty')).rejects.toThrow('offline');
  fail = false;
  expect(await fs.read('tex/latex/a.sty')).toBeTruthy();
  const bad = createPackageFs({
    index,
    version: 'v',
    fetchPackage: async () => ({ bytes: new Uint8Array([1]), format: 'tar' }),
  });
  await expect(bad.resolve!('a.sty')).rejects.toThrow('integrity');
  expect(await fs.resolve!('missing.sty')).toEqual([]);
});

it('handles SHA-512 XZ archives, dependency cycles, resident limits and corrupt caches', async () => {
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const raw = buildTar([{ path: 'RELOC/tex/latex/a.sty', content: 'AAAA' }]);
  const bytes = new Uint8Array(execFileSync('xz', ['-zc'], { input: raw }));
  const sum = createHash('sha512').update(bytes).digest('hex');
  const index = parseTlpdb(
    `name a\ncontainerchecksum ${sum}\ndepend b\nrunfiles n=1\n RELOC/tex/latex/a.sty\nname b\ncontainerchecksum ${sum}\ndepend a\nrunfiles n=1\n RELOC/tex/latex/a.sty`,
    'v',
  );
  let writes = 0;
  const fs = createPackageFs({
    index,
    version: 'v',
    cache: {
      get: async () => new Uint8Array([0, 1, 2]),
      put: async () => {
        writes++;
      },
    },
    fetchPackage: async () => ({ bytes, format: 'xz' }),
  });
  expect(await fs.read('tex/latex/a.sty')).toBeTruthy();
  expect(writes).toBe(2);
  const limit = createPackageFs({
    index,
    version: 'v',
    maxResidentBytes: 0,
    fetchPackage: async () => ({ bytes, format: 'xz' }),
  });
  await expect(limit.resolve!('a.sty')).rejects.toThrow('resident');
  const expanded = createPackageFs({
    index,
    version: 'v',
    maxBytes: bytes.length + 1,
    fetchPackage: async () => ({ bytes, format: 'xz' }),
  });
  await expect(expanded.resolve!('a.sty')).rejects.toThrow(/limit/);
  const { decodePackageXz } = await import('../src/packages/xz');
  await expect(decodePackageXz(bytes, 1)).rejects.toThrow('limit');
});
it('loads only a digest-pinned HTTP index and uses the public archive URL', async () => {
  const { loadPackageIndex, createHttpPackageFs } = await import('../src/packages/http');
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const raw = buildTar([{ path: 'RELOC/tex/latex/a.sty', content: 'A' }]);
  const archive = new Uint8Array(execFileSync('xz', ['-zc'], { input: raw }));
  const checksum = createHash('sha512').update(archive).digest('hex');
  const index = parseTlpdb(
    `name a\nrevision 1\ncontainerchecksum ${checksum}\nrunfiles n=1\n RELOC/tex/latex/a.sty`,
    'v',
  );
  const bytes = new TextEncoder().encode(JSON.stringify(index));
  const digest = await sha256Hex(bytes);
  const fetch = vi.fn(
    async (url: string) => new Response(new Uint8Array(url.endsWith('.xz') ? archive : bytes)),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    const loaded = await loadPackageIndex('https://app.test/index.json', digest);
    const fs = createHttpPackageFs({
      index: loaded,
      version: 'v',
      baseUrl: 'https://tl.test/2023/',
    });
    expect(await fs.read('tex/latex/a.sty')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('https://tl.test/2023/archive/a.tar.xz');
    await expect(loadPackageIndex('https://app.test/index.json', 'bad')).rejects.toThrow('SHA-256');
    await expect(loadPackageIndex('https://app.test/index.json', '0'.repeat(64))).rejects.toThrow(
      'integrity',
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it('ignores inherited names in JSON-loaded filename indexes', () => {
  expect(packagesForFile({ version: 'v', packages: {}, byFile: {} }, 'constructor')).toEqual([]);
});
