/** Fetch runtime assets; Node additionally supports explicitly configured local file URLs. */
export async function fetchAsset(url: string, options?: RequestInit): Promise<Response> {
  if (url.startsWith('file:') && typeof process !== 'undefined' && process.versions?.node) {
    const moduleName = 'node:fs/promises';
    const fs = (await import(/* @vite-ignore */ moduleName)) as typeof import('node:fs/promises');
    const bytes = await fs.readFile(
      new URL(url),
      options?.signal ? { signal: options.signal } : {},
    );
    return new Response(bytes);
  }
  return options ? fetch(url, options) : fetch(url);
}
