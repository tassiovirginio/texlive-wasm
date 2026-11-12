import type { VfsBackend } from '../core/types';
import { safeRelativePath } from '../core/paths';
import { sha256Hex } from '../core/manifest';
import { decodePackageXz } from './xz';
import { decompress, untar, MAX_DECOMPRESSED_BYTES } from '../vfs/tar';
export interface PackageRecord {
  revision: string;
  checksum: string;
  files: string[];
  dependencies: string[];
}
export interface PackageIndex {
  version: string;
  packages: Record<string, PackageRecord>;
  byFile: Record<string, string[]>;
}
/** Parse runfiles only. Keep full TDS names and all candidate packages. */
export function parseTlpdb(source: string, version: string): PackageIndex {
  const packages: Record<string, PackageRecord> = Object.create(null),
    byFile: Record<string, string[]> = Object.create(null);
  let name = '',
    run = false;
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('name ')) {
      name = line.slice(5).trim();
      run = false;
      if (!/^[a-z0-9][\w+-]*$/i.test(name)) {
        name = '';
        continue;
      }
      packages[name] = { revision: '', checksum: '', files: [], dependencies: [] };
    } else if (name && line.startsWith('revision '))
      packages[name]!.revision = line.slice(9).trim();
    else if (name && line.startsWith('containerchecksum '))
      packages[name]!.checksum = line.slice(18).trim();
    else if (name && line.startsWith('depend ')) {
      const dep = line.slice(7).trim();
      if (/^[a-z0-9][\w+-]*$/i.test(dep)) packages[name]!.dependencies.push(dep);
    } else if (line.startsWith('runfiles ')) run = true;
    else if (name && run && line.startsWith(' ')) {
      const path = safeRelativePath(line.trim().replace(/^(?:texmf-dist|RELOC)\//, ''));
      if (!path || !/^(tex|fonts|bibtex|makeindex|scripts)\//.test(path)) continue;
      packages[name]!.files.push(path);
      const base = path.slice(path.lastIndexOf('/') + 1);
      (byFile[base] ??= []).push(name);
    } else if (!line.startsWith(' ')) run = false;
  }
  return { version, packages, byFile };
}
export function packagesForFile(index: PackageIndex, name: string): string[] {
  const base = name.replace(/\\/g, '/').split('/').pop()!;
  if (!base || base.startsWith('.') || /[\0\r\n]/.test(base)) return [];
  const candidates = [
    base,
    ...(!base.includes('.')
      ? ['sty', 'cls', 'tex', 'otf', 'ttf', 'ttc', 'tfm', 'bst'].map((ext) => base + '.' + ext)
      : []),
  ];
  const found = new Set<string>();
  for (const candidate of candidates) {
    for (const pkg of Object.hasOwn(index.byFile, candidate) ? index.byFile[candidate]! : [])
      found.add(pkg);
    if (!found.size)
      for (const [file, pkgs] of Object.entries(index.byFile))
        if (file.toLowerCase() === candidate.toLowerCase()) for (const pkg of pkgs) found.add(pkg);
  }
  return [...found].sort(
    (a, b) =>
      Number(a.endsWith('-dev')) - Number(b.endsWith('-dev')) ||
      a.length - b.length ||
      a.localeCompare(b),
  );
}
export interface PackageArchive {
  bytes: Uint8Array;
  format: 'tar' | 'gzip' | 'xz';
}
export interface PackageCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}
export interface PackageFsOptions {
  index: PackageIndex;
  /** Trusted profile identity required, so a provider cannot silently change vintage. */
  version: string;
  fetchPackage(name: string, record: PackageRecord): Promise<PackageArchive>;
  decodeXz?: (bytes: Uint8Array, maxBytes: number) => Promise<Uint8Array>;
  cache?: PackageCache;
  maxBytes?: number;
  maxResidentBytes?: number;
  onPackage?: (name: string, source: 'cache' | 'network') => void;
}
/** Verified optional package provider. Never sends project sources to the provider. */
export function createPackageFs(options: PackageFsOptions): VfsBackend {
  if (options.index.version !== options.version)
    throw new Error('Package profile version mismatch');
  const files = new Map<string, Uint8Array>(),
    pending = new Map<string, Promise<void>>();
  const max = options.maxBytes ?? MAX_DECOMPRESSED_BYTES;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Invalid package byte limit');
  let residentBytes = 0;
  const residentLimit = options.maxResidentBytes ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(residentLimit) || residentLimit < 0)
    throw new Error('Invalid package resident limit');
  let queue: Promise<unknown> = Promise.resolve();
  const ensure = (name: string) => {
    const next = queue.then(() => load(name));
    queue = next.catch(() => {});
    return next;
  };
  const load = async (name: string, ancestry = new Set<string>()): Promise<void> => {
    if (ancestry.has(name)) return;
    if (pending.has(name)) return pending.get(name)!;
    const record = options.index.packages[name];
    if (!record) throw new Error(`Unknown package dependency ${name}`);
    const task = (async () => {
      if (!/^(?:[a-f0-9]{64}|[a-f0-9]{128})$/i.test(record.checksum))
        throw new Error(`Missing package integrity: ${name}`);
      const key = options.version + ':' + name + ':' + record.checksum;
      const cached = await options.cache?.get(key).catch(() => null);
      let cacheHit = false;
      let archive: PackageArchive;
      const verify = async (bytes: Uint8Array) => {
        if (bytes.length > max) throw new Error('Package download exceeds limit');
        const got =
          record.checksum.length === 64
            ? await sha256Hex(bytes)
            : Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(bytes))),
              )
                .map((x) => x.toString(16).padStart(2, '0'))
                .join('');
        return got === record.checksum.toLowerCase();
      };
      // Cached bytes include a one-byte format prefix and are rechecked before use.
      if (cached && cached[0]! <= 2 && (await verify(cached.subarray(1)))) {
        cacheHit = true;
        archive = {
          bytes: cached.subarray(1),
          format: cached[0] === 0 ? 'tar' : cached[0] === 1 ? 'gzip' : 'xz',
        };
      } else {
        archive = await options.fetchPackage(name, record);
        if (!(await verify(archive.bytes))) throw new Error(`Package integrity mismatch: ${name}`);
      }
      const raw =
        archive.format === 'tar'
          ? archive.bytes
          : archive.format === 'gzip'
            ? await decompress(archive.bytes, 'gzip', max)
            : await (options.decodeXz ?? decodePackageXz)(archive.bytes, max);
      if (raw.length > max) throw new Error('Expanded package exceeds limit');
      const extracted = new Map<string, Uint8Array>();
      for (const entry of untar(raw)) {
        if (entry.type !== 'file') continue;
        const path = safeRelativePath(entry.path.replace(/^(?:texmf-dist|texmf|RELOC)\//, ''));
        if (!path || !record.files.includes(path)) continue;
        extracted.set(path, entry.content.slice());
      }
      const chain = new Set([...ancestry, name]);
      for (const dependency of record.dependencies) await load(dependency, chain);
      const additional = [...extracted]
        .filter(([path]) => !files.has(path))
        .reduce((sum, [, bytes]) => sum + bytes.length, 0);
      if (residentBytes + additional > residentLimit)
        throw new Error('Package resident memory limit exceeded');
      for (const [path, bytes] of extracted)
        if (!files.has(path)) {
          files.set(path, bytes);
          residentBytes += bytes.length;
        }
      if (!cacheHit && options.cache) {
        const bytes = new Uint8Array(archive.bytes.length + 1);
        bytes[0] = archive.format === 'tar' ? 0 : archive.format === 'gzip' ? 1 : 2;
        bytes.set(archive.bytes, 1);
        await options.cache.put(key, bytes).catch(() => {});
      }
      options.onPackage?.(name, cacheHit ? 'cache' : 'network');
    })();
    pending.set(name, task);
    try {
      await task;
    } catch (error) {
      pending.delete(name);
      throw error;
    }
  };
  return {
    id: 'packages-' + options.version,
    async read(path) {
      if (files.has(path)) return files.get(path)!;
      const candidate = packagesForFile(options.index, path).find((name) =>
        options.index.packages[name]!.files.includes(path),
      );
      if (candidate) await ensure(candidate);
      return files.get(path) ?? null;
    },
    async resolve(name) {
      const pkgs = packagesForFile(options.index, name);
      if (!pkgs.length) return [];
      await ensure(pkgs[0]!);
      return [...files].map(([path, content]) => ({ path, content }));
    },
    dispose() {
      files.clear();
      residentBytes = 0;
      pending.clear();
    },
  };
}
