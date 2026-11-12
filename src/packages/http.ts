import { fetchAsset } from '../core/assets';
import { readLimited } from '../core/download';
import { assertSha256 } from '../core/manifest';
import { safeRelativePath } from '../core/paths';
import { createPackageFs, type PackageFsOptions, type PackageIndex } from './index';
/** Download a release index only after its externally pinned digest matches. */
export async function loadPackageIndex(
  url: string,
  sha256: string,
  maxBytes = 128 * 1024 * 1024,
): Promise<PackageIndex> {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Package index needs SHA-256');
  const r = await fetchAsset(url);
  if (!r.ok) throw new Error(`Package index HTTP ${r.status}`);
  const bytes = await readLimited(r, maxBytes);
  await assertSha256(bytes, sha256, 'package index');
  const index = JSON.parse(new TextDecoder().decode(bytes)) as PackageIndex;
  if (!index || typeof index.version !== 'string' || !index.packages || !index.byFile)
    throw new Error('Invalid package index');
  for (const [name, pkg] of Object.entries(index.packages)) {
    if (
      !/^[a-z0-9][\w+-]*$/i.test(name) ||
      !pkg ||
      typeof pkg.revision !== 'string' ||
      typeof pkg.checksum !== 'string' ||
      !Array.isArray(pkg.files) ||
      !Array.isArray(pkg.dependencies) ||
      pkg.files.some((p) => typeof p !== 'string' || safeRelativePath(p) !== p) ||
      pkg.dependencies.some((d) => typeof d !== 'string' || !/^[a-z0-9][\w+-]*$/i.test(d))
    )
      throw new Error('Invalid package record');
  }
  for (const [name, pkgs] of Object.entries(index.byFile))
    if (!name || !Array.isArray(pkgs) || pkgs.some((p) => !Object.hasOwn(index.packages, p)))
      throw new Error('Invalid package filename index');
  return index;
}
/** HTTP/file provider needs only public package names, never document content. */
export function createHttpPackageFs(
  options: Omit<PackageFsOptions, 'fetchPackage'> & { baseUrl: string },
) {
  return createPackageFs({
    ...options,
    async fetchPackage(name) {
      if (!/^[a-z0-9][\w+-]*$/i.test(name)) throw new Error('Invalid package name');
      const r = await fetchAsset(new URL(`archive/${name}.tar.xz`, options.baseUrl).href);
      if (!r.ok) throw new Error(`Package HTTP ${r.status}: ${name}`);
      return { bytes: await readLimited(r, options.maxBytes ?? 128 * 1024 * 1024), format: 'xz' };
    },
  });
}
