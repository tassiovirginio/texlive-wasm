import { safeRelativePath } from '../core/paths';
/** Preserve all bytes in legacy 8-bit TeX control files as well as UTF-8. */
export function binaryText(bytes?: Uint8Array): string {
  if (!bytes) return '';
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return result;
}
const text = binaryText;

/** Include every chapter auxiliary and every layout control file. */
export function auxiliarySnapshot(files: Map<string, Uint8Array>): string {
  return JSON.stringify(
    [...files]
      .filter(([p]) => /\.(aux|toc|out|nav|snm|lof|lot|lol|bcf|run\.xml)$/.test(p))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, b]) => [p, text(b)]),
  );
}

/** Page labels do not change BibTeX input; recursively follow chapter aux. */
export function bibliographySignature(files: Map<string, Uint8Array>, main: string): string {
  const seen = new Set<string>();
  const visit = (path: string): string => {
    if (seen.has(path)) return '';
    seen.add(path);
    return text(files.get(path))
      .split('\n')
      .flatMap((line) => {
        const child = /\\@input\{([^}]+)\}/.exec(line)?.[1];
        if (child) {
          const decoded = new TextDecoder().decode(Uint8Array.from(child, (c) => c.charCodeAt(0)));
          const nested = visit(files.has(child) ? child : decoded);
          return nested ? [nested] : [];
        }
        return /\\(?:citation|bibdata|bibstyle|abx@aux@)/.test(line) ? [line] : [];
      })
      .join('\n');
  };
  return visit(main);
}

export interface IndexJob {
  input: string;
  output: string;
  transcript: string;
  style?: string;
  glossary?: boolean;
}
export function indexJobs(
  files: Map<string, Uint8Array>,
  indexes: boolean,
  glossaries: boolean,
): IndexJob[] {
  const jobs = new Map<string, IndexJob>();
  if (indexes)
    for (const path of files.keys()) {
      if (/\.idx$/.test(path))
        jobs.set(path, {
          input: path,
          output: path.replace(/\.idx$/, '.ind'),
          transcript: path.replace(/\.idx$/, '.ilg'),
        });
    }
  if (glossaries)
    for (const [path, bytes] of files) {
      if (!path.endsWith('.aux')) continue;
      const aux = new TextDecoder().decode(bytes);
      // xindy requires a host integration, never silently feed it to makeindex.
      if (/\\@istfilename\{[^}]+\.xdy\}/.test(aux)) continue;
      const style = /\\@istfilename\{([^}]+)\}/.exec(aux)?.[1];
      for (const m of aux.matchAll(/\\@newglossary\{[^}]+\}\{([^}]+)\}\{([^}]+)\}\{([^}]+)\}/g)) {
        if (![m[1], m[2], m[3]].every((ext) => /^[A-Za-z0-9_-]+$/.test(ext!))) continue;
        const stem = path.replace(/\.aux$/, '');
        const input = `${stem}.${m[3]}`;
        const output = `${stem}.${m[2]}`;
        const transcript = `${stem}.${m[1]}`;
        if (
          ![input, output, transcript, ...(style ? [style] : [])].every(
            (p) => safeRelativePath(p) === p,
          )
        )
          continue;
        if (files.has(input))
          jobs.set(input, {
            input,
            output,
            transcript,
            glossary: true,
            ...(style ? { style } : {}),
          });
      }
    }
  return [...jobs.values()];
}
