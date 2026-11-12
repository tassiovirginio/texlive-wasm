import { it, expect } from 'vitest';
import { analyzeProject, maskTex, projectPath } from '../src/project/analyze';
import { detectFontFamilies, selectFontPacks } from '../src/project/fonts';
import { refineSynctex, normalizedWords } from '../src/synctex/refine';
const f = (path: string, content: string) => ({ path, content });
it('follows actual project inputs and ignores commands in examples/comments', () => {
  const files = [
    f(
      'main.tex',
      String.raw`\documentclass{article}
% \input{fake}
\begin{verbatim}\input{fake}\end{verbatim}
\verb|\input{fake}|
\input{sections/a}\includegraphics{image}\bibliography{refs}\usepackage{minted}`,
    ),
    f('sections/a.tex', 'Text'),
    f('image.png', 'image'),
    f('refs.bib', 'data'),
    f('unused.tex', 'unused'),
  ];
  const r = analyzeProject(files, 'main.tex');
  expect(r.used).toEqual(['image.png', 'main.tex', 'refs.bib', 'sections/a.tex']);
  expect(r.unused).toEqual(['unused.tex']);
  expect(r.tools).toEqual(['pygments']);
  expect(r.problems.map((p) => p.code)).toEqual(['external-tool']);
});
it('resolves local classes, graphicspath, relative includes and case diagnostics with lines', () => {
  const r = analyzeProject(
    [
      f(
        'docs/main.tex',
        '\\documentclass{local}\n\\graphicspath{{images/}}\\includegraphics{plot}\n\\input{part}\n\\input{MISSING}',
      ),
      f('local.cls', '\\RequirePackage{localpkg}'),
      f('localpkg.sty', ''),
      f('images/plot.pdf', 'PDF'),
      f('docs/Part.tex', ''),
    ],
    'docs/main.tex',
  );
  expect(r.problems.map((p) => [p.code, p.line])).toEqual([
    ['case-mismatch', 3],
    ['missing-file', 4],
  ]);
  expect(r.used).toContain('images/plot.pdf');
  expect(analyzeProject([], 'no.tex').problems[0]!.code).toBe('missing-file');
});
it('confines relative paths and preserves escaped comments', () => {
  expect(projectPath('../outside')).toBeNull();
  expect(projectPath('a/../../b')).toBeNull();
  expect(projectPath('C:/bad')).toBeNull();
  expect(projectPath('/bad')).toBeNull();
  expect(projectPath('a/../b')).toBe('b');
  expect(maskTex('\\% text % hidden')).toBe('\\% text         ');
});
it('selects exact font packs and dependencies without automatic font substitution', () => {
  const files = [
    f(
      'main.tex',
      '\\usepackage{newtxtext,libertine}\n% \\usepackage{montserrat}\n\\setmainfont{Noto Sans}',
    ),
  ];
  expect(detectFontFamilies(files)).toEqual(['libertine', 'newtx', 'noto']);
  const pack = { url: 'font.tar.gz', sha256: 'a'.repeat(64), size: 123 };
  const catalog = {
    version: 'v1',
    families: { newtx: { ...pack, dependencies: ['ec'], maps: ['newtx.map'] }, ec: pack },
  };
  const r = selectFontPacks(files, catalog, 'https://app.test/fonts/');
  expect(r.families).toEqual(['ec', 'newtx']);
  expect(r.unknown).toEqual(['libertine', 'noto']);
  expect(r.packs[0]!.url).toBe('https://app.test/fonts/font.tar.gz');
  expect(r.maps).toEqual(['newtx.map']);
  expect(() =>
    selectFontPacks(
      files,
      { version: 'v', families: { newtx: { ...pack, sha256: 'bad' } } },
      'https://app.test/',
    ),
  ).toThrow('Invalid');
  expect(() =>
    selectFontPacks(
      files,
      { version: 'v', families: { newtx: { ...pack, dependencies: ['newtx'] } } },
      'https://app.test/',
    ),
  ).toThrow('Cyclic');
});
it('detects literal font family and fontspec declarations in binary sources', () => {
  const files = [
    {
      path: 'font.sty',
      content: new TextEncoder().encode(
        '\\RequirePackage{inconsolata,montserrat,tgtermes,times}\\fontfamily{ptm}\\setmainfont{Linux Libertine}',
      ),
    },
  ];
  expect(detectFontFamilies(files)).toEqual([
    'inconsolata',
    'libertine',
    'montserrat',
    'psnfss',
    'tex-gyre',
  ]);
});
it('refines titles and Unicode ligatures while preserving ambiguous SyncTeX answers', () => {
  const files = [
    f('main.tex', '\\title{Ação of the ﬁrst chapter}\n\\maketitle\nHello world\nHello world'),
    f('other.tex', 'Hello world'),
  ];
  expect(normalizedWords('Ação ﬁrst')).toEqual(['acao', 'first']);
  expect(
    refineSynctex(files, 'Ação of the first', {
      preferred: { file: 'class.cls', line: 500, column: 0 },
    }),
  ).toEqual({ file: 'main.tex', line: 1, column: 8 });
  const preferred = { file: 'main.tex', line: 4, column: 0 };
  expect(refineSynctex(files, 'Hello world', { preferred })?.line).toBe(4);
  expect(refineSynctex(files, 'Hello world')).toBeNull();
  expect(refineSynctex(files, 'of', { preferred })).toBe(preferred);
  expect(refineSynctex(files, 'absent', { preferred })).toBe(preferred);
  expect(refineSynctex(files, 'Hello world', { mainTex: 'other.tex' })?.file).toBe('other.tex');
});

it('reports conservative reference and citation hints and focuses a word across source lines', () => {
  const files = [
    f(
      'main.tex',
      String.raw`\label{known}\ref{known}\ref{missing}\cite{good,bad}\nocite{*}\bibliography{refs}`,
    ),
    f('refs.bib', '@article{good, title={Test}}'),
  ];
  const hints = analyzeProject(files, 'main.tex').problems;
  expect(hints.filter((p) => p.code === 'undefined-reference')).toHaveLength(1);
  expect(hints.filter((p) => p.code === 'undefined-citation')).toHaveLength(1);
  expect(hints.every((p) => p.severity === 'warning')).toBe(true);
  expect(
    refineSynctex([f('main.tex', 'Unique phrase\nacross lines')], 'Unique phrase across lines', {
      focus: 2,
    }),
  ).toEqual({ file: 'main.tex', line: 2, column: 1 });
});
