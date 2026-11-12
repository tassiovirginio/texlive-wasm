import type { FileInput } from './types';
import { safeRelativePath } from './paths';
import { sha256Hex } from './manifest';
export interface InputReference {
  path: string;
  sha256: string;
}
export interface InputBlob {
  sha256: string;
  content: Uint8Array;
}
/** Worker-local LRU, never persisted. Every request contains the complete path list. */
export class InputBlobCache {
  private blobs = new Map<string, Uint8Array>();
  private size = 0;
  constructor(private readonly limit: number = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid projectCacheBytes');
  }
  async receive(
    refs: InputReference[],
    incoming: InputBlob[],
  ): Promise<{ files: FileInput[]; sentBytes: number; reusedBytes: number }> {
    const provided = new Map<string, Uint8Array>();
    let sentBytes = 0,
      reusedBytes = 0;
    for (const blob of incoming) {
      if (!/^[a-f0-9]{64}$/.test(blob.sha256) || (await sha256Hex(blob.content)) !== blob.sha256)
        throw new Error('Project blob integrity mismatch');
      provided.set(blob.sha256, blob.content);
      sentBytes += blob.content.length;
    }
    const resolved = new Map<string, Uint8Array>();
    const files: FileInput[] = [],
      paths = new Set<string>();
    for (const ref of refs) {
      const path = safeRelativePath(ref.path);
      if (path !== ref.path || paths.has(path))
        throw new Error('Invalid or duplicate project path');
      paths.add(path);
      const bytes = provided.get(ref.sha256) ?? this.blobs.get(ref.sha256);
      if (!bytes) throw new Error(`Missing project blob: ${ref.sha256}`);
      if (!provided.has(ref.sha256)) reusedBytes += bytes.length;
      resolved.set(ref.sha256, bytes);
      files.push({ path, content: bytes });
    }
    for (const ref of refs) {
      const bytes = resolved.get(ref.sha256)!;
      if (this.blobs.has(ref.sha256)) {
        this.size -= this.blobs.get(ref.sha256)!.length;
        this.blobs.delete(ref.sha256);
      }
      if (bytes.length <= this.limit) {
        this.blobs.set(ref.sha256, bytes);
        this.size += bytes.length;
      }
      while (this.size > this.limit) {
        const key = this.blobs.keys().next().value!;
        this.size -= this.blobs.get(key)!.length;
        this.blobs.delete(key);
      }
    }
    return { files, sentBytes, reusedBytes };
  }
  keys(): string[] {
    return [...this.blobs.keys()];
  }
  clear(): void {
    this.blobs.clear();
    this.size = 0;
  }
}
