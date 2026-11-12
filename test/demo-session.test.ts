import { it, expect, vi } from 'vitest';
const fake = vi.hoisted(() => ({ compile: vi.fn() }));
vi.mock('@typeward/texlive-wasm', () => ({ createCompileSession: () => fake }));
it('uses strict incremental sessions in the showcase and surfaces content diagnostics', async () => {
  vi.stubGlobal('document', { baseURI: 'https://app.test/' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('bundle')),
  );
  try {
    const demo = await import('../demo/src/engine-manager');
    const req = {
      engine: 'pdflatex' as const,
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: 'SOURCE' }],
    };
    fake.compile.mockResolvedValueOnce({ success: true, passes: 1, diagnostics: [] });
    await demo.compile(req);
    expect(fake.compile).toHaveBeenCalledWith({ ...req, strict: true, rerun: 'auto' });
    expect(demo.engineStatus()).toContain('1 pass');
    fake.compile.mockResolvedValueOnce({
      success: false,
      exitCode: 0,
      diagnostics: [{ message: 'Missing glyph' }],
    });
    await demo.compile(req);
    expect(demo.engineStatus()).toBe('Missing glyph');
  } finally {
    vi.unstubAllGlobals();
  }
});
