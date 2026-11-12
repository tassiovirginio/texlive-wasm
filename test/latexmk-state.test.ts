import { it, expect } from 'vitest';
import { diagnose } from '../src/latexmk/diagnostics';
import { bibliographySignature, indexJobs } from '../src/latexmk/state';
const map = (o: Record<string, string>) =>
  new Map(Object.entries(o).map(([p, s]) => [p, new TextEncoder().encode(s)]));
it('reports font substitution and undefined references without duplicating messages', () => {
  expect(
    diagnose(
      'Font shape OT1/a/b/c undefined\nThere were undefined references\nThere were undefined references',
    ).map((d) => d.code),
  ).toEqual(['font-substitution', 'undefined-reference']);
});
it('follows chapter bibliography input without looping on cyclic aux files', () => {
  const m = map({
    'main.aux': '\\@input{chapter.aux}',
    'chapter.aux': '\\citation{child}\n\\@input{main.aux}',
  });
  expect(bibliographySignature(m, 'main.aux')).toBe('\\citation{child}');
  expect(bibliographySignature(m, 'none')).toBe('');
});
it('does not process xindy glossaries or unsafe auxiliary output declarations', () => {
  expect(
    indexJobs(
      map({
        'main.aux': '\\@istfilename{main.xdy}\n\\@newglossary{main}{glg}{gls}{glo}',
        'main.glo': 'G',
      }),
      false,
      true,
    ),
  ).toEqual([]);
  expect(
    indexJobs(
      map({ 'main.aux': '\\@newglossary{main}{glg}{../bad}{glo}', 'main.glo': 'G' }),
      false,
      true,
    ),
  ).toEqual([]);
  expect(
    indexJobs(
      map({ 'main.aux': '\\@newglossary{main}{glg}{gls}{glo}', 'main.glo': 'G' }),
      false,
      true,
    ),
  ).toHaveLength(1);
});

it('does not treat different legacy 8-bit auxiliaries as equivalent replacement characters', async () => {
  const { auxiliarySnapshot } = await import('../src/latexmk/state');
  const a = new Map([['main.aux', new Uint8Array([0x80])]]);
  const b = new Map([['main.aux', new Uint8Array([0x81])]]);
  expect(auxiliarySnapshot(a)).not.toBe(auxiliarySnapshot(b));
});

it('resolves Unicode chapter and glossary filenames while comparing their original bytes', () => {
  const files = map({
    'main.aux': '\\@input{capítulo.aux}',
    'capítulo.aux':
      '\\citation{child}\n\\@istfilename{índice.ist}\n\\@newglossary{main}{glg}{gls}{glo}',
    'capítulo.glo': 'G',
  });
  expect(bibliographySignature(files, 'main.aux')).toContain('\\citation{child}');
  expect(indexJobs(files, false, true)[0]!.style).toBe('índice.ist');
});
