import type { FileInput } from '../core/types';
export interface ProjectProblem {
  code:
    | 'missing-file'
    | 'case-mismatch'
    | 'external-tool'
    | 'undefined-reference'
    | 'undefined-citation';
  severity: 'error' | 'warning';
  file: string;
  line: number;
  message: string;
}
export interface ProjectAnalysis {
  used: string[];
  unused: string[];
  packages: string[];
  tools: string[];
  problems: ProjectProblem[];
}
export const sourceOf = (file: FileInput): string =>
  typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content);
/** Hide examples and comments while preserving offsets for source diagnostics. */
export function maskTex(source: string): string {
  const blank = (text: string) => text.replace(/[^\n\r]/g, ' ');
  let text = source.replace(
    /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}/g,
    blank,
  );
  text = text.replace(/\\verb\*?([^\w\s*])[^\n]*?\1/g, blank);
  return text
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') {
          i++;
          continue;
        }
        if (line[i] === '%') return line.slice(0, i) + ' '.repeat(line.length - i);
      }
      return line;
    })
    .join('\n');
}
export function projectPath(path: string): string | null {
  if (/^[a-z]+:|^[/\\]|\0/i.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/') || null;
}
const dir = (path: string) => path.split('/').slice(0, -1).join('/');
const textFile = /\.(tex|ltx|sty|cls|clo|def|cfg|fd|bbx|cbx|lbx)$/i;
/** Conservative static analysis; dynamic macro paths remain engine-resolved. */
export function analyzeProject(files: FileInput[], mainTex: string): ProjectAnalysis {
  const index = new Map(files.map((f) => [projectPath(f.path) ?? f.path, f]));
  const used = new Set<string>(),
    packages = new Set<string>(),
    tools = new Set<string>();
  const problems: ProjectProblem[] = [];
  const main = projectPath(mainTex) ?? mainTex;
  const lower = new Map([...index.keys()].map((p) => [p.toLowerCase(), p]));
  const visit = (path: string): void => {
    if (used.has(path)) return;
    used.add(path);
    const file = index.get(path);
    if (!file || !textFile.test(path)) return;
    const code = maskTex(sourceOf(file));
    const imageDirs = [...code.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g)].flatMap(
      (m) => [...m[1]!.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]!),
    );
    const pattern =
      /\\(input|include|subfile|includegraphics\*?|bibliography|addbibresource|bibliographystyle|usepackage|RequirePackage|documentclass|LoadClass)(?![A-Za-z@])\s*(?:\[[^\]]*\])?\s*(?:\{([^}]+)\}|([^\s\\{}%]+))/g;
    for (const m of code.matchAll(pattern)) {
      const command = m[1]!,
        line = code.slice(0, m.index).split('\n').length;
      for (const value of (m[2] ?? m[3]!).split(',').map((s) => s.trim())) {
        if (!value || /[\\#]/.test(value)) continue;
        const packageCommand = /package|class/i.test(command);
        const exts = /graphics/.test(command)
          ? ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.mps', '.svg']
          : /bibliographystyle/.test(command)
            ? ['.bst']
            : /bibliography|bibresource/.test(command)
              ? ['.bib']
              : /package/i.test(command)
                ? ['.sty']
                : /class/i.test(command)
                  ? ['.cls']
                  : ['.tex'];
        const names = /\.[^/]+$/.test(value) ? [value] : exts.map((ext) => value + ext);
        const roots = ['', dir(main), dir(path), ...(/graphics/.test(command) ? imageDirs : [])];
        const candidates = [
          ...new Set(
            roots
              .flatMap((root) => names.map((name) => projectPath(root ? root + '/' + name : name)))
              .filter((p): p is string => !!p),
          ),
        ];
        const found = candidates.find((p) => index.has(p));
        if (found) {
          visit(found);
          continue;
        }
        const wrongCase = candidates.map((p) => lower.get(p.toLowerCase())).find(Boolean);
        if (wrongCase) {
          visit(wrongCase);
          problems.push({
            code: 'case-mismatch',
            severity: 'error',
            file: path,
            line,
            message: `${value} differs in case from ${wrongCase}`,
          });
          continue;
        }
        if (packageCommand || command === 'bibliographystyle') {
          packages.add(value);
          const external: Record<string, string> = {
            minted: 'pygments',
            svg: 'inkscape',
            pythontex: 'python',
            sagetex: 'sage',
            gnuplottex: 'gnuplot',
          };
          if (external[value]) {
            tools.add(external[value]);
            problems.push({
              code: 'external-tool',
              severity: 'warning',
              file: path,
              line,
              message: `${value} requires host tool ${external[value]}`,
            });
          }
        } else
          problems.push({
            code: 'missing-file',
            severity: 'error',
            file: path,
            line,
            message: `Missing project input: ${value}`,
          });
      }
    }
  };
  if (!index.has(main))
    problems.push({
      code: 'missing-file',
      severity: 'error',
      file: main,
      line: 1,
      message: 'Main file is missing',
    });
  else visit(main);
  const labels = new Set<string>(),
    citations = new Set<string>();
  const scanned = [...used].flatMap((path) => {
    const file = index.get(path)!;
    return textFile.test(path) ? [{ path, code: maskTex(sourceOf(file)) }] : [];
  });
  for (const { code } of scanned)
    for (const m of code.matchAll(/\\label\s*\{([^}]+)\}/g)) labels.add(m[1]!);
  for (const path of used) {
    const file = index.get(path)!;
    if (/\.bib$/i.test(path))
      for (const m of sourceOf(file).matchAll(/@(?:[a-z]+)\s*[{(]\s*([^,\s]+)\s*,/gi))
        citations.add(m[1]!);
  }
  for (const { path, code } of scanned) {
    for (const m of code.matchAll(/\\(?:ref|pageref|eqref|autoref|cref|Cref)\*?\s*\{([^}]+)\}/g))
      for (const label of m[1]!.split(',').map((s) => s.trim())) {
        if (!/[\\#]/.test(label) && !labels.has(label))
          problems.push({
            code: 'undefined-reference',
            severity: 'warning',
            file: path,
            line: code.slice(0, m.index).split('\n').length,
            message: `Reference may be undefined: ${label}`,
          });
      }
    for (const m of code.matchAll(
      /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g,
    ))
      for (const key of m[1]!.split(',').map((s) => s.trim())) {
        if (key !== '*' && !/[\\#]/.test(key) && !citations.has(key))
          problems.push({
            code: 'undefined-citation',
            severity: 'warning',
            file: path,
            line: code.slice(0, m.index).split('\n').length,
            message: `Citation may be undefined: ${key}`,
          });
      }
  }
  return {
    used: [...used].sort(),
    unused: [...index.keys()].filter((p) => !used.has(p)).sort(),
    packages: [...packages].sort(),
    tools: [...tools].sort(),
    problems,
  };
}
