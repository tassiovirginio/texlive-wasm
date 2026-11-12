import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

describe('TDS completion gate', () => {
  function run(setup: (root: string) => void, env = {}) {
    const root = mkdtempSync(join(tmpdir(), 'tds-gate-'));
    try {
      mkdirSync(join(root, 'scripts'));
      cpSync('scripts/fetch-tds.sh', join(root, 'scripts/fetch-tds.sh'));
      mkdirSync(join(root, 'scripts/data'));
      cpSync('scripts/data/tds-packages.lock', join(root, 'scripts/data/tds-packages.lock'));
      mkdirSync(join(root, 'engine-artifacts/texmf'), { recursive: true });
      setup(root);
      return spawnSync('bash', [join(root, 'scripts/fetch-tds.sh')], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  it('refuses partial trees instead of silently skipping the fetch', () => {
    const r = run((root) => writeFileSync(join(root, 'engine-artifacts/texmf/partial'), 'x'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no completion marker');
  });
  it('rejects malformed snapshot identifiers without invoking Docker', () => {
    expect(run(() => {}, { TDS_SNAPSHOT: 'bad' }).stderr).toContain('Invalid TDS_SNAPSHOT');
  });
  it('rejects a stale or incomplete completion marker', () => {
    const r = run((root) =>
      writeFileSync(
        join(root, 'engine-artifacts/texmf/.tds-complete'),
        `locked:${createHash('sha256').update(readFileSync('scripts/data/tds-packages.lock')).digest('hex')}\n`,
      ),
    );
    expect(r.stderr).toContain('Incomplete TDS');
  });
  it('accepts a complete tree from the requested snapshot without network access', () => {
    const r = run((root) => {
      const target = join(root, 'engine-artifacts/texmf');
      writeFileSync(
        join(target, '.tds-complete'),
        `locked:${createHash('sha256').update(readFileSync('scripts/data/tds-packages.lock')).digest('hex')}\n`,
      );
      for (const file of [
        'tex/latex/base/article.cls',
        'tex/latex/base/latex.ltx',
        'web2c/texmf.cnf',
        'ls-R',
      ]) {
        const full = join(target, file);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, 'x');
      }
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Verified complete');
  });
});
