/** Build optional font packs from a pinned historic TeX Live index and verified archives. */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTlpdb, packagesForFile } from '../src/packages';
import { untar } from '../src/vfs/tar';
import { safeRelativePath } from '../src/core/paths';
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, 'engine-artifacts'),
  cache = join(artifacts, 'font-source');
const profile = JSON.parse(await readFile(join(root, 'scripts/data/font-packs.json'), 'utf8')) as {
  version: string;
  repository: string;
  indexSha512: string;
  families: Record<string, string[]>;
};
const hash = (bytes: Uint8Array, algorithm = 'sha512') =>
  createHash(algorithm).update(bytes).digest('hex');
await mkdir(cache, { recursive: true });
async function verifiedFile(name: string, expected: string): Promise<Uint8Array> {
  const path = join(cache, name);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readFile(path);
  } catch {}
  if (bytes && hash(bytes) === expected) return bytes;
  const r = await fetch(new URL(name, profile.repository), { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Font source HTTP ${r.status}: ${name}`);
  bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > 256 * 1024 * 1024 || hash(bytes) !== expected)
    throw new Error(`Font source integrity mismatch: ${name}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}
const compressed = await verifiedFile('tlpkg/texlive.tlpdb.xz', profile.indexSha512);
const unpack = (bytes: Uint8Array) =>
  new Uint8Array(
    execFileSync('xz', ['--decompress', '--stdout'], {
      input: bytes,
      maxBuffer: 512 * 1024 * 1024,
    }),
  );
const tlpdb = new TextDecoder().decode(unpack(compressed));
const index = parseTlpdb(tlpdb, profile.version);
const licenses = new Map(
  tlpdb
    .split(/\n\n/)
    .map((block) => [
      block.match(/^name (.+)$/m)?.[1],
      block.match(/^catalogue-license (.+)$/m)?.[1] ?? 'See original files and TeX Live catalog',
    ]),
);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
const catalog: { version: string; profile: string; families: Record<string, unknown> } = {
  version: pkg.version,
  profile: profile.version,
  families: {},
};
for (const [family, names] of Object.entries(profile.families)) {
  if (!/^[a-z0-9-]+$/.test(family)) throw new Error('Invalid font family');
  const target = join(artifacts, 'font-packs', family);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const maps: string[] = [],
    provenance: Record<string, unknown> = {};
  for (const requested of names) {
    const name = Object.hasOwn(index.packages, requested)
      ? requested
      : packagesForFile(index, requested)[0];
    if (!name) throw new Error(`Unknown font dependency ${requested}`);
    const record = index.packages[name];
    if (!record || !/^[a-f0-9]{128}$/i.test(record.checksum))
      throw new Error(`Missing pinned font package ${name}`);
    const bytes = await verifiedFile(`archive/${name}.tar.xz`, record.checksum);
    provenance[name] = {
      revision: record.revision,
      sha512: record.checksum,
      license: licenses.get(name),
    };
    for (const entry of untar(unpack(bytes))) {
      if (entry.type !== 'file') continue;
      const path = safeRelativePath(entry.path.replace(/^(texmf-dist|RELOC)\//, ''));
      if (!path) continue;
      const license = /\/(?:copyright|copying|license(?:\.\w+)?|readme(?:\.\w+)?)$/i.test(path);
      if (license) {
        const out = join(target, 'licenses', name, path.split('/').pop()!);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, entry.content);
        continue;
      }
      if (!/^(tex\/|fonts\/(tfm|vf|type1|enc|map|opentype|truetype)\/)/.test(path)) continue;
      // The Noto Type1 package is enormous; this exact family is Sans only.
      if (
        family === 'noto' &&
        path.startsWith('fonts/') &&
        !/\/NotoSans[-/]/i.test(path) &&
        !/^fonts\/(?:enc|map)\//.test(path)
      )
        continue;
      // IBM Courier is not part of this redistributable profile. URW remains exact, never synthesized.
      if (path.startsWith('fonts/type1/adobe/courier/')) continue;
      const out = join(target, path);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, entry.content);
      if (path.endsWith('.map')) maps.push(path);
    }
  }
  const activation = `texlive-${family}.map`;
  const lines = new Set<string>();
  for (const map of maps)
    for (const line of (await readFile(join(target, map), 'utf8')).split(/\r?\n/))
      if (
        line.trim() &&
        !line.trim().startsWith('%') &&
        (family !== 'noto' || line.startsWith('NotoSans-'))
      )
        lines.add(line);
  const mapDir = join(target, 'fonts/map/dvips/texlive-wasm');
  await mkdir(mapDir, { recursive: true });
  await writeFile(join(mapDir, activation), [...lines].join('\n') + '\n');
  await writeFile(
    join(target, 'provenance.json'),
    JSON.stringify(
      { profile: profile.version, indexSha512: profile.indexSha512, packages: provenance },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(target, 'LICENSE.TL'), await readFile(join(root, 'LICENSE.TL')));
  await writeFile(
    join(target, 'NOTICE'),
    'Optional exact-family TeX Live resource pack. Original files retain their own licenses and embedded copyright notices. See provenance.json for pinned original packages and archive hashes. This pack does not relicense fonts under the SDK MIT license. Original package sources: ' +
      profile.repository +
      '\n',
  );
  const stem = `texmf-font-${family}`;
  execFileSync(
    process.execPath,
    [join(root, 'scripts/pack-tds.mjs'), '--source', target, '--stem', stem, '--no-brotli'],
    { stdio: 'inherit' },
  );
  const archive = await readFile(join(artifacts, stem + '.tar.gz'));
  catalog.families[family] = {
    url: stem + '.tar.gz',
    sha256: hash(archive, 'sha256'),
    size: archive.length,
    maps: lines.size ? [activation] : [],
  };
  console.log(`font pack ${family}: ${archive.length} bytes`);
}
await writeFile(join(artifacts, 'font-packs.json'), JSON.stringify(catalog, null, 2) + '\n');
// A complete index is available for explicit providers without forcing it into every worker.
await writeFile(join(artifacts, 'texlive-package-index.json'), JSON.stringify(index));
