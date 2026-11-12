import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { version } from '../package.json';
it('publishes optional fonts with checksums and rejects catalogs from different bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-fonts-'));
  const output = join(root, 'out');
  const bytes = Buffer.from('original archive bytes');
  const pack = { url: 'texmf-font-test-family.tar.gz', sha256: '0'.repeat(64), size: bytes.length };
  const save = () =>
    writeFileSync(
      join(root, 'font-packs.json'),
      JSON.stringify({ version, families: { test: pack } }),
    );
  const run = () =>
    execFileSync(
      process.execPath,
      ['scripts/pack-release.mjs', '--artifacts', root, '--out', output],
      { stdio: 'pipe' },
    );
  try {
    writeFileSync(join(root, pack.url), bytes);
    save();
    expect(run).toThrow(/Font catalog asset mismatch/);
    pack.sha256 = createHash('sha256').update(bytes).digest('hex');
    save();
    run();
    const sums = JSON.parse(readFileSync(join(output, 'checksums.json'), 'utf8'));
    expect(sums.assets[pack.url]).toEqual({ size: bytes.length, sha256: pack.sha256 });
    expect(readFileSync(join(output, pack.url))).toEqual(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
