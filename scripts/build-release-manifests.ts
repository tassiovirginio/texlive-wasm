/** Publish a full manifest plus an integrity-pinned manifest for each mobile core. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify, buildManifest } from './build-manifest';
import type { TexPackagesManifest } from '../src/core/manifest';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function buildReleaseManifests(
  artifacts = join(root, 'engine-artifacts'),
): Promise<void> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const full = join(artifacts, 'texmf.tar.gz');
  await mkdir(artifacts, { recursive: true });
  await buildManifest([
    '--tds',
    join(artifacts, 'texmf'),
    '--out',
    join(artifacts, 'tex-packages.json'),
    '--version',
    pkg.version,
    '--core-bundle-url',
    'texmf.tar.gz',
    '--core-bundle-file',
    full,
    '--full-bundle-url',
    'texmf.tar.gz',
    '--full-bundle-file',
    full,
  ]);
  const base = JSON.parse(
    await readFile(join(artifacts, 'tex-packages.json'), 'utf8'),
  ) as TexPackagesManifest;
  base.environment = {
    id:
      'ubuntu-noble-tl2023-' +
      createHash('sha256')
        .update(await readFile(join(root, 'scripts/data/tds-packages.lock')))
        .digest('hex'),
    engines: 'TeX Live 2026',
    tds: 'Ubuntu 24.04 / TeX Live 2023 (locked packages)',
  };
  await writeFile(join(artifacts, 'tex-packages.json'), JSON.stringify(base, null, 2) + '\n');
  const patterns = async (path: string) =>
    (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  const common = await patterns(join(root, 'scripts/data/core-tier.list'));
  const strip = await patterns(join(root, 'engine/configs/mobile-strip.list'));
  const packs: Record<string, { url: string; sha256: string; size: number }> = {};
  for (const name of ['portuguese', 'multilingual']) {
    const url = `texmf-pack-${name}.tar.gz`;
    try {
      const bytes = await readFile(join(artifacts, url));
      packs[name] = {
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: (await stat(join(artifacts, url))).size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await writeFile(
    join(artifacts, 'resource-packs.json'),
    JSON.stringify({ version: pkg.version, packs }, null, 2) + '\n',
  );
  for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
    const bundle = `texmf-core-${engine}.tar.gz`;
    const core = [
      ...common,
      ...(await patterns(join(root, `scripts/data/core-tier.${engine}.list`))),
    ];
    const manifest = {
      ...base,
      coreBundleUrl: bundle,
      coreBundleSha256: createHash('sha256')
        .update(await readFile(join(artifacts, bundle)))
        .digest('hex'),
      files: Object.fromEntries(
        Object.entries(base.files).map(([path, entry]) => [
          path,
          { ...entry, tier: classify(path, core, strip) },
        ]),
      ),
    };
    await writeFile(
      join(artifacts, `tex-packages-${engine}.json`),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildReleaseManifests(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
