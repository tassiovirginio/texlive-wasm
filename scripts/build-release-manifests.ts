/** Publish a full manifest plus an integrity-pinned manifest for each mobile core. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  const patterns = async (path: string) =>
    (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  const common = await patterns(join(root, 'scripts/data/core-tier.list'));
  const strip = await patterns(join(root, 'engine/configs/mobile-strip.list'));
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
