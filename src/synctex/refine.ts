import type { FileInput } from '../core/types';
import type { SynctexReverseHit } from './index';
import { maskTex, sourceOf } from '../project/analyze';
export function normalizedWords(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase('en')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}
interface Token {
  word: string;
  line: number;
  column: number;
}
function tokens(source: string): Token[] {
  return maskTex(source)
    .replace(/\\[a-z@]+\*?|\\./gi, (m) => ' '.repeat(m.length))
    .split('\n')
    .flatMap((line, i) =>
      [...line.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((m) => ({
        word: normalizedWords(m[0]).join(''),
        line: i + 1,
        column: m.index + 1,
      })),
    );
}
export interface RefineOptions {
  preferred?: SynctexReverseHit;
  mainTex?: string;
  radius?: number;
  /** Word under the click within the supplied phrase, zero-based. */
  focus?: number;
}
/** Refine a viewer-provided clicked phrase; ambiguous text never replaces geometry. */
export function refineSynctex(
  files: FileInput[],
  phrase: string,
  options: RefineOptions = {},
): SynctexReverseHit | null {
  const words = normalizedWords(phrase);
  if (!words.length || (words.length === 1 && words[0]!.length < 5))
    return options.preferred ?? null;
  const focus =
    Number.isSafeInteger(options.focus) && options.focus! >= 0 && options.focus! < words.length
      ? options.focus!
      : 0;
  const candidates: SynctexReverseHit[] = [];
  for (const file of files) {
    if (!/\.(tex|ltx)$/i.test(file.path)) continue;
    const all = tokens(sourceOf(file));
    for (let i = 0; i <= all.length - words.length; i++)
      if (words.every((word, j) => all[i + j]!.word === word))
        candidates.push({
          file: file.path,
          line: all[i + focus]!.line,
          column: all[i + focus]!.column,
        });
  }
  if (!candidates.length) return options.preferred ?? null;
  const preferred = options.preferred;
  if (preferred) {
    const same = candidates.filter(
      (c) => c.file.replace(/^\.\//, '') === preferred.file.replace(/^\.\//, ''),
    );
    if (same.length) {
      same.sort(
        (a, b) =>
          Math.abs(a.line - preferred.line) - Math.abs(b.line - preferred.line) || a.line - b.line,
      );
      const best = same[0]!;
      if (Math.abs(best.line - preferred.line) <= (options.radius ?? 2)) return best;
      if (same.length === 1 && words.length >= 2) return best;
    }
  }
  if (candidates.length === 1) return candidates[0]!;
  if (options.mainTex && words.length >= 2) {
    const main = candidates.filter((c) => c.file === options.mainTex);
    if (main.length === 1) return main[0]!;
  }
  return preferred ?? null;
}
