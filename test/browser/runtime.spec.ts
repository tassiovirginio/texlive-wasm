import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/browser/');
});
test('packaged worker runs a multi-pass document and transfers outputs', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const entry = '/dist/index.js';
    const { createEngine, latexmk } = await import(entry);
    const handle = await createEngine('pdflatex', {
      enginePath: new URL('/test/browser/fake-engine.wasm?v=1', location.href).href,
      vfs: [
        {
          id: 'fixture',
          list: () => ['web2c/pdftex/pdflatex.fmt'],
          read: () => new TextEncoder().encode('FMT'),
        },
      ],
    });
    try {
      const result = await latexmk({
        engine: 'pdflatex',
        mainTex: 'main.tex',
        files: [{ path: 'main.tex', content: 'hello' }],
        handles: { tex: handle },
      });
      return {
        success: result.success,
        converged: result.converged,
        passes: result.passes,
        pdf: new TextDecoder().decode(result.pdf),
      };
    } finally {
      await handle.dispose();
    }
  });
  expect(result).toEqual({
    success: true,
    converged: true,
    passes: 2,
    pdf: '%PDF-1.5 runtime fixture',
  });
});
test('manager recovers after terminating a looping worker', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const entry = '/dist/index.js';
    const { createEngineManager } = await import(entry);
    const manager = createEngineManager({
      maxLiveEngines: 1,
      config: () => ({
        enginePath: new URL('/test/browser/fake-engine.wasm', location.href).href,
        vfs: [
          {
            id: 'fixture',
            list: () => ['web2c/pdftex/pdflatex.fmt'],
            read: () => new TextEncoder().encode('FMT'),
          },
        ],
      }),
    });
    try {
      const handle = await manager.engine('pdflatex');
      let error = '';
      try {
        await handle.run({ args: ['hang'], timeoutMs: 1000 });
      } catch (e) {
        error = String(e);
      }
      const dead = !handle.isReady();
      const result = await handle.run({ args: ['main.tex'] });
      return { error, dead, recovered: handle.isReady(), exit: result.exitCode };
    } finally {
      await manager.dispose();
    }
  });
  expect(result.error).toContain('exceeded');
  expect(result.dead).toBe(true);
  expect(result.recovered).toBe(true);
  expect(result.exit).toBe(0);
});
test('OPFS persists fetched files and rejects content absent from its manifest', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const entry = '/dist/index.js';
    const { createOpfsFs, withIntegrity, sha256Hex, defaultBackends } = await import(entry);
    if (!navigator.storage?.getDirectory) {
      return {
        fallback: true,
        layers: (await defaultBackends('pdflatex', {})).map((b: { id: string }) => b.id),
      };
    }
    const version = `browser-${Date.now()}`;
    const a = await createOpfsFs({ version });
    const bytes = new TextEncoder().encode('cached');
    await a.write('tex/known.sty', bytes);
    await a.write('tex/unknown.sty', bytes);
    const b = await createOpfsFs({ version });
    const verified = withIntegrity(b, {
      files: { 'tex/known.sty': { sha256: await sha256Hex(bytes) } },
    });
    const known = await verified.read('tex/known.sty');
    const unknown = await verified.read('tex/unknown.sty');
    const root = await navigator.storage.getDirectory();
    const tl = await root.getDirectoryHandle('texlive-wasm');
    await tl.removeEntry(version, { recursive: true });
    return { known: new TextDecoder().decode(known), unknown };
  });
  if ('fallback' in result) expect(result).toEqual({ fallback: true, layers: [] });
  else expect(result).toEqual({ known: 'cached', unknown: null });
});

test('worker reuses content hashes and accepts changed bytes and deletions', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const entry = '/dist/index.js';
    const { createEngine } = await import(entry);
    const h = await createEngine('pdflatex', {
      enginePath: new URL('/test/browser/fake-engine.wasm', location.href).href,
      vfs: [
        {
          id: 'fixture',
          list: () => ['web2c/pdftex/pdflatex.fmt'],
          read: () => new TextEncoder().encode('FMT'),
        },
      ],
    });
    try {
      const content = new Uint8Array(4096).fill(7);
      const first = await h.run({
        args: ['main.tex'],
        files: [
          { path: 'main.tex', content: 'hello' },
          { path: 'asset.bin', content },
        ],
      });
      const second = await h.run({
        args: ['main.tex'],
        files: [
          { path: 'main.tex', content: 'hello' },
          { path: 'asset.bin', content },
        ],
      });
      content[0] = 8;
      const third = await h.run({
        args: ['main.tex'],
        files: [
          { path: 'main.tex', content: 'hello' },
          { path: 'asset.bin', content },
        ],
      });
      const fourth = await h.run({
        args: ['main.tex'],
        files: [{ path: 'main.tex', content: 'hello' }],
      });
      return [
        first.inputTransport,
        second.inputTransport,
        third.inputTransport,
        fourth.inputTransport,
      ];
    } finally {
      await h.dispose();
    }
  });
  expect(result).toEqual([
    { sentBytes: 4101, reusedBytes: 0 },
    { sentBytes: 0, reusedBytes: 4101 },
    { sentBytes: 4096, reusedBytes: 5 },
    { sentBytes: 0, reusedBytes: 5 },
  ]);
});

test('decodes bounded XZ packages in the browser', async ({ page }) => {
  const text = await page.evaluate(async () => {
    const entry = '/dist/index.js';
    const { decodePackageXz } = await import(entry);
    const bytes = Uint8Array.from(
      atob(
        '/Td6WFoAAATm1rRGBMAXEyEBFgAAAAAAAAAAAFRp7t4BABJWZXJpZmllZCBicm93c2VyIFhaAADcXkr9gJI93wABMxPFkVNQH7bzfQEAAAAABFla',
      ),
      (c) => c.charCodeAt(0),
    );
    return new TextDecoder().decode(await decodePackageXz(bytes, 1024));
  });
  expect(text).toBe('Verified browser XZ');
});
