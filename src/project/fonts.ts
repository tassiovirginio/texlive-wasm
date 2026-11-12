import type { FileInput } from '../core/types';
import { maskTex, sourceOf } from './analyze';
export interface FontPack {
  url: string;
  sha256: string;
  size: number;
  dependencies?: string[];
  maps?: string[];
}
export interface FontCatalog {
  version: string;
  families: Record<string, FontPack>;
}
const packageFamilies: Record<string, RegExp> = {
  psnfss:
    /^(times|mathptmx|helvet|courier|palatino|mathpazo|bookman|newcent|avant|pifont|chancery|utopia)$/i,
  libertine: /^(libertine|biolinum)/i,
  newtx: /^(newtx|txfonts)/i,
  inconsolata: /^(inconsolata|zi4)$/i,
  montserrat: /^montserrat/i,
  noto: /^noto/i,
  'tex-gyre': /^tg(?:termes|heros|cursor|pagella|schola|bonum|adventor)|^tex-gyre/i,
};
export function detectFontFamilies(files: FileInput[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    if (!/\.(tex|sty|cls|ltx)$/i.test(file.path)) continue;
    const text = maskTex(sourceOf(file));
    for (const m of text.matchAll(
      /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    )) {
      for (const name of m[1]!.split(',').map((s) => s.trim()))
        for (const [family, re] of Object.entries(packageFamilies))
          if (re.test(name)) found.add(family);
    }
    for (const m of text.matchAll(
      /\\(?:setmainfont|setsansfont|setmonofont|fontfamily)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g,
    )) {
      const name = m[1]!;
      for (const [family, re] of Object.entries({
        libertine: /linux libertine|biolinum|^ll[a-z]/i,
        newtx: /^ntx|^txr/i,
        inconsolata: /inconsolata|^zi4/i,
        montserrat: /montserrat/i,
        noto: /noto/i,
        'tex-gyre': /tex[ -]?gyre/i,
        psnfss: /^ptm|^phv|^pcr|^ppl/i,
      }))
        if (re.test(name)) found.add(family);
    }
  }
  return [...found].sort();
}
/** Select exact families and dependency packs; never substitute a different font. */
export function selectFontPacks(
  files: FileInput[],
  catalog: FontCatalog,
  baseUrl: string,
  extraFamilies: string[] = [],
): { families: string[]; packs: FontPack[]; maps: string[]; unknown: string[] } {
  const selected = new Set<string>(),
    unknown = new Set<string>(),
    visiting = new Set<string>();
  const visit = (name: string) => {
    if (selected.has(name)) return;
    if (visiting.has(name)) throw new Error(`Cyclic font pack dependency: ${name}`);
    const pack = catalog.families[name];
    if (!pack) {
      unknown.add(name);
      return;
    }
    if (!/^[a-f0-9]{64}$/i.test(pack.sha256) || !Number.isSafeInteger(pack.size) || pack.size < 0)
      throw new Error(`Invalid font pack: ${name}`);
    visiting.add(name);
    for (const dependency of pack.dependencies ?? []) visit(dependency);
    visiting.delete(name);
    selected.add(name);
  };
  for (const name of [...detectFontFamilies(files), ...extraFamilies]) visit(name);
  const packs = [...selected].map((name) => ({
    ...catalog.families[name]!,
    url: new URL(catalog.families[name]!.url, baseUrl).href,
  }));
  return {
    families: [...selected],
    packs,
    maps: [...new Set(packs.flatMap((p) => p.maps ?? []))],
    unknown: [...unknown],
  };
}
