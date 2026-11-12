import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildReleaseManifests } from '../scripts/build-release-manifests';
import { validateManifest } from '../src/core/manifest';
it('publishes versioned per-engine manifests with matching bundle and file hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-manifests-'));
  try {
    await mkdir(join(root, 'texmf/web2c/pdftex'), { recursive: true });
    await writeFile(join(root, 'texmf/web2c/pdftex/pdflatex.fmt'), 'FMT');
    for (const name of [
      'texmf',
      'texmf-core-pdflatex',
      'texmf-core-xelatex',
      'texmf-core-lualatex',
    ])
      await writeFile(join(root, `${name}.tar.gz`), name);
    await buildReleaseManifests(root);
    const manifest = validateManifest(
      JSON.parse(await readFile(join(root, 'tex-packages-pdflatex.json'), 'utf8')),
    );
    expect(manifest.coreBundleUrl).toBe('texmf-core-pdflatex.tar.gz');
    expect(manifest.coreBundleSha256).toBe(
      createHash('sha256').update('texmf-core-pdflatex').digest('hex'),
    );
    expect(manifest.files['web2c/pdftex/pdflatex.fmt']!.tier).toBe('core');
    expect(manifest.files['web2c/pdftex/pdflatex.fmt']!.sha256).toBe(
      createHash('sha256').update('FMT').digest('hex'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
