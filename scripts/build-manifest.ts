#!/usr/bin/env tsx
/**
 * build-manifest.ts
 *
 * Walk a built TDS tree, compute SHA-256 for every file, classify it into a
 * tier (core | full | cdn), and emit a tex-packages.json manifest.
 *
 * Inputs (env or CLI):
 *   --tds <path>          Path to the built TDS root (defaults to
 *                         engine/source/texlive-source/build/output/texmf-dist).
 *   --core-list <path>    Newline-separated list of TDS paths in the core tier.
 *                         Defaults to scripts/data/core-tier.list.
 *   --full-strip <path>   Path to engine/configs/mobile-strip.list. Anything
 *                         matching is omitted from the full tier (still
 *                         reachable via CDN).
 *   --out <path>          Output manifest path. Defaults to
 *                         dist/tex-packages.json.
 *   --core-bundle-url     Optional URL to embed in the manifest.
 *   --core-bundle-file    The packed core bundle. Hashed into coreBundleSha256,
 *                         which is what the runtime verifies the download
 *                         against before unpacking it.
 *   --full-bundle-url     Optional URL to embed.
 *   --full-bundle-file    As --core-bundle-file, for the full tier.
 *   --cdn-base-url        Optional URL to embed.
 *   --version <id>        e.g. "texlive-wasm-2026.0".
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

interface ManifestEntry {
  sha256: string;
  size: number;
  tier: 'core' | 'full' | 'cdn';
  package: string | null;
}

interface Manifest {
  schema: 1;
  version: string;
  generatedAt: string;
  coreBundleUrl: string | null;
  coreBundleSha256: string | null;
  fullBundleUrl: string | null;
  fullBundleSha256: string | null;
  cdnBaseUrl: string | null;
  files: Record<string, ManifestEntry>;
}

export async function buildManifest(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      tds: { type: 'string', default: 'engine/source/texlive-source/build/output/texmf-dist' },
      'core-list': { type: 'string', default: 'scripts/data/core-tier.list' },
      'full-strip': { type: 'string', default: 'engine/configs/mobile-strip.list' },
      out: { type: 'string', default: 'dist/tex-packages.json' },
      'core-bundle-url': { type: 'string', default: '' },
      'core-bundle-file': { type: 'string', default: '' },
      'full-bundle-url': { type: 'string', default: '' },
      'full-bundle-file': { type: 'string', default: '' },
      'cdn-base-url': { type: 'string', default: '' },
      version: { type: 'string', default: `texlive-wasm-dev-${Date.now()}` },
    },
  });

  const tdsRoot = resolve(values.tds!);
  const rootStat = await stat(tdsRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`build-manifest: TDS root ${tdsRoot} does not exist — pass --tds <path>.`);
  }
  const corePatterns = await readPatternList(values['core-list']!);
  const stripPatterns = await readPatternList(values['full-strip']!);

  const files: Record<string, ManifestEntry> = {};
  for await (const abs of walk(tdsRoot)) {
    const rel = relative(tdsRoot, abs).replace(/\\/g, '/');
    const bytes = await readFile(abs);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const tier = classify(rel, corePatterns, stripPatterns);
    const pkg = inferPackage(rel);
    files[rel] = { sha256, size: bytes.byteLength, tier, package: pkg };
  }
  if (Object.keys(files).length === 0) {
    throw new Error(
      `build-manifest: no files found under ${tdsRoot} — refusing to write an empty manifest.`,
    );
  }

  // The runtime verifies the whole compressed bundle against this digest
  // before it unpacks it (src/vfs/bundlefs.ts), so a cross-origin bundle
  // published without one will simply refuse to load.
  const coreBundleSha256 = await hashBundle(values['core-bundle-file']!, '--core-bundle-file');
  const fullBundleSha256 = await hashBundle(values['full-bundle-file']!, '--full-bundle-file');
  if (values['core-bundle-url'] && !coreBundleSha256) {
    console.warn(
      'build-manifest: --core-bundle-url given without --core-bundle-file, so the manifest ' +
        'carries no coreBundleSha256. A cross-origin bundle without a digest is refused at ' +
        'runtime; pass the packed .tar.gz so its hash can be recorded.',
    );
  }

  const manifest: Manifest = {
    schema: 1,
    version: values.version!,
    generatedAt: new Date().toISOString(),
    coreBundleUrl: values['core-bundle-url'] || null,
    coreBundleSha256,
    fullBundleUrl: values['full-bundle-url'] || null,
    fullBundleSha256,
    cdnBaseUrl: values['cdn-base-url'] || null,
    files,
  };

  const outPath = resolve(values.out!);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(manifest, null, 2));

  const counts = { core: 0, full: 0, cdn: 0 };
  let totalSize = 0;
  for (const entry of Object.values(files)) {
    counts[entry.tier]++;
    if (entry.tier !== 'cdn') totalSize += entry.size;
  }
  console.log(
    `Wrote ${outPath}\n` +
      `  files: ${Object.keys(files).length} (core ${counts.core}, full ${counts.full}, cdn ${counts.cdn})\n` +
      `  bundled size: ${(totalSize / 1024 / 1024).toFixed(1)} MB (uncompressed, core+full)`,
  );
}

async function hashBundle(path: string, flag: string): Promise<string | null> {
  if (!path) return null;
  const abs = resolve(path);
  const bytes = await readFile(abs).catch(() => null);
  if (!bytes) {
    throw new Error(`build-manifest: ${flag} ${abs} does not exist`);
  }
  if (bytes.byteLength === 0) {
    throw new Error(`build-manifest: ${flag} ${abs} is empty — that is not a bundle`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

async function readPatternList(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export function classify(
  rel: string,
  corePatterns: string[],
  stripPatterns: string[],
): 'core' | 'full' | 'cdn' {
  if (matchesAny(rel, corePatterns)) return 'core';
  if (matchesAny(rel, stripPatterns)) return 'cdn';
  return 'full';
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globMatch(p, path));
}

/**
 * Tiny glob matcher: supports `*` (no /), `**` (any depth, including a
 * trailing `dir/**` matching every file below dir), and literal segments.
 * Sufficient for the patterns we use; not a full POSIX glob.
 */
export function globMatch(pattern: string, path: string): boolean {
  const re =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*$/, '<<ALL>>')
      .replace(/\*\*\//g, '<<ANYDIRS>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<ALL>>/, '.*')
      .replace(/<<ANYDIRS>>/g, '(?:[^/]+/)*') +
    '$';
  return new RegExp(re).test(path);
}

/** Best-effort: a TDS path like tex/latex/geometry/geometry.sty → "geometry". */
export function inferPackage(rel: string): string | null {
  const parts = rel.split('/');
  // tex/{latex,generic,plain}/<pkg>/<file>
  if (parts[0] === 'tex' && parts.length >= 4) return parts[2] ?? null;
  // fonts/<format>/public/<family>/<file>
  if (parts[0] === 'fonts' && parts.length >= 5 && parts[2] === 'public') {
    return parts[3] ?? null;
  }
  // bibtex/{bst,bib}/<pkg>/<file>
  if (parts[0] === 'bibtex' && parts.length >= 4) return parts[2] ?? null;
  return null;
}

// Only run when invoked as a script (tests import the helpers above).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildManifest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
