import { describe, it, expect } from 'vitest';
import { willRunBibtex, willRunBiber, willRunMakeindex, stripTexComments } from '../src/latexmk';

describe('TeX source inspection', () => {
  it.each([willRunBibtex, willRunBiber, willRunMakeindex])(
    'ignores commented commands and non-source files',
    (detect) => {
      expect(
        detect([
          {
            path: 'main.tex',
            content: '% \\usepackage{biblatex} \\bibliography{refs} \\makeindex',
          },
        ]),
      ).toBe(false);
      expect(
        detect([
          { path: 'image.svg', content: '\\usepackage{biblatex} \\bibliography{refs} \\makeindex' },
        ]),
      ).toBe(false);
    },
  );
  it('counts escaping backslashes correctly and preserves newlines', () => {
    expect(stripTexComments('a\\%b %comment\nc\\\\%comment\nd')).toBe('a\\%b \nc\\\\\nd');
  });
  it('inspects byte sources and multiline biblatex options', () => {
    const files = [
      {
        path: 'main.tex',
        content: new TextEncoder().encode('\\usepackage[\n%comment\nbackend=bibtex\n]{biblatex}'),
      },
    ];
    expect(willRunBibtex(files)).toBe(true);
    expect(willRunBiber(files)).toBe(false);
  });
});

it('matches the shared TypeScript/Rust source-detection contract', async () => {
  const { default: fixtures } = await import('./fixtures/source-detection.json');
  for (const fixture of fixtures) {
    const files = [{ path: fixture.path, content: fixture.content }];
    expect(willRunBibtex(files)).toBe(fixture.bibtex);
    expect(willRunBiber(files)).toBe(fixture.biber);
    expect(willRunMakeindex(files)).toBe(fixture.makeindex);
  }
});

it('ignores unrelated source files when a main document is supplied and follows literal local inputs', () => {
  const files = [
    { path: 'main.tex', content: 'Hello' },
    { path: 'unused.tex', content: '\\usepackage{biblatex}' },
  ];
  expect(willRunBiber(files, 'main.tex')).toBe(false);
  files[0]!.content = '\\input unused.tex';
  expect(willRunBiber(files, 'main.tex')).toBe(true);
  files[0]!.content = '\\input\\dynamic';
  expect(willRunBiber(files, 'main.tex')).toBe(true);
});
