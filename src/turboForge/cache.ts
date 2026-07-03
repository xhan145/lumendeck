import type { CompileCacheEntry, CompileCacheKeyParts } from './types';

export function createCompileCacheKey(parts: CompileCacheKeyParts): string {
  return [
    parts.modelHash,
    parts.backendId,
    parts.hardwareId,
    parts.precision,
    parts.resolutionBucket,
    parts.batchSize,
    parts.appVersion ?? 'app-dev',
    parts.optimizationMode,
    parts.graphVersion ?? 'graph-dev',
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join('|');
}

export function resolutionBucket(width: number, height: number): string {
  const bucket = (n: number) => Math.ceil(n / 128) * 128;
  return `${bucket(width)}x${bucket(height)}`;
}

export class CompileCache {
  private entries = new Map<string, CompileCacheEntry>();

  get(parts: CompileCacheKeyParts): CompileCacheEntry {
    const key = createCompileCacheKey(parts);
    const found = this.entries.get(key);
    if (!found) {
      return { ...parts, key, createdAt: '', lastUsedAt: '', stale: false, status: 'miss' };
    }
    const next = { ...found, lastUsedAt: new Date().toISOString(), status: found.stale ? 'stale' : 'hit' } as CompileCacheEntry;
    this.entries.set(key, next);
    return next;
  }

  put(parts: CompileCacheKeyParts, sizeBytes?: number): CompileCacheEntry {
    const key = createCompileCacheKey(parts);
    const now = new Date().toISOString();
    const entry: CompileCacheEntry = {
      ...parts,
      key,
      createdAt: now,
      lastUsedAt: now,
      sizeBytes,
      stale: false,
      status: 'hit',
    };
    this.entries.set(key, entry);
    return entry;
  }

  markStale(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.entries.set(key, { ...entry, stale: true, status: 'stale' });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  list(): CompileCacheEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  estimateSizeBytes(): number {
    return this.list().reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  }
}

export const turboCompileCache = new CompileCache();
