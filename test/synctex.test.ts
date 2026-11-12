import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createSynctex } from '../src/synctex';

const SYNCTEX_TEXT =
  'SyncTeX Version:1\n' +
  'Input:1:/project/main.tex\n' +
  'Input:2:/project/chapters/intro.tex\n' +
  'Output:pdf\n' +
  'Magnification:1000\n';

describe('createSynctex', () => {
  it('parses the gzip-compressed form engines actually emit (.synctex.gz)', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from(SYNCTEX_TEXT, 'utf8')));
    const lookup = await createSynctex(gz);
    expect(lookup.files().sort()).toEqual(['/project/chapters/intro.tex', '/project/main.tex']);
  });

  it('parses already-decompressed text identically', async () => {
    const lookup = await createSynctex(new TextEncoder().encode(SYNCTEX_TEXT));
    expect(lookup.files()).toHaveLength(2);
  });
});

const positional = (extra = '') =>
  new TextEncoder().encode(
    [
      SYNCTEX_TEXT,
      'Unit:1',
      'X Offset:0',
      'Y Offset:0',
      'Content:',
      '{1',
      '(1,10:6578176,13156352:6578176,657818,0',
      'x1,10,4:6578176,=',
      ')',
      '(2,20:13156352,19734528:6578176,657818,0',
      ')',
      '}1',
      '{2',
      '(1,30:6578176,6578176:6578176,657818,0',
      ')',
      '}2',
      'Postamble:',
      extra,
    ].join('\n'),
  );
it('maps source lines to page rectangles in PDF points and performs reverse lookup', async () => {
  const lookup = await createSynctex(positional());
  const [hit] = lookup.forward('main.tex', 10);
  expect(hit!.page).toBe(1);
  expect(hit!.x).toBeCloseTo(100);
  expect(hit!.y).toBeCloseTo(190, 3);
  expect(hit!.width).toBeCloseTo(100);
  expect(lookup.reverse(1, 120, 195)).toEqual([{ file: '/project/main.tex', line: 10, column: 0 }]);
  expect(lookup.forward('chapters/intro.tex', 19)[0]!.page).toBe(1);
  expect(lookup.forward('missing.tex', 10)).toEqual([]);
  expect(lookup.reverse(999, 0, 0)).toEqual([]);
  expect(lookup.forward('main.tex', -1)).toEqual([]);
  expect(lookup.reverse(1, NaN, 0)).toEqual([]);
});
it('honors compressed positions, columns, pages and postscript transformations', async () => {
  const lookup = await createSynctex(
    positional('Post Scriptum:\nMagnification:2\nX Offset:1in\nY Offset:72bp'),
  );
  const [hit] = lookup.forward('/project/main.tex', 10, 4);
  expect(hit!.x).toBeCloseTo(272);
  expect(hit!.y).toBeCloseTo(452, 3);
  expect(lookup.forward('main.tex', 30)[0]!.page).toBe(2);
  expect(lookup.reverse(1, hit!.x, hit!.y)[0]!.column).toBe(4);
});
it('parses records from a real upstream SyncTeX fixture', async () => {
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync('test/fixtures/upstream-footest.synctex'));
  const lookup = await createSynctex(bytes);
  const hits = lookup.forward('test.tex', 24);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => Number.isFinite(h.x) && h.page > 0)).toBe(true);
});

it('resolves PDF form references at every placement', async () => {
  const text = [
    'SyncTeX Version:1',
    'Input:1:/project/form.tex',
    'Unit:1',
    'Magnification:1000',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '<7',
    '(1,42:0,657818:657818,657818,0',
    ')',
    '>',
    '{1',
    'f7:6578176,13156352',
    '}1',
    '{2',
    'f7:13156352,19734528',
    '}2',
  ].join('\n');
  const lookup = await createSynctex(new TextEncoder().encode(text));
  const hits = lookup.forward('form.tex', 42);
  expect(hits.map((h) => h.page)).toEqual([1, 2]);
  expect(hits[0]!.x).toBeCloseTo(100);
  expect(hits[0]!.y).toBeCloseTo(190, 3);
  expect(lookup.reverse(2, 205, 295)[0]!.line).toBe(42);
});

it('resolves the dot segments emitted by the real WASM engine', async () => {
  const { readFileSync } = await import('node:fs');
  const lookup = await createSynctex(
    new Uint8Array(readFileSync('test/fixtures/pdflatex.synctex')),
  );
  const hits = lookup.forward('main.tex', 1);
  expect(hits.length).toBeGreaterThan(0);
  expect(lookup.forward('/project/main.tex', 1)).toEqual(hits);
  expect(lookup.forward('/project/./main.tex', 1)).toEqual(hits);
});
