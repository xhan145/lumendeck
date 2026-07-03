import type { BenchmarkResult } from './types';

export interface BenchmarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'lumendeck.turboforge.benchmarks.v1';

export function measuredSpeedupPercent(baselineMs?: number, optimizedMs?: number): number | undefined {
  if (!baselineMs || !optimizedMs || baselineMs <= 0 || optimizedMs <= 0) return undefined;
  return ((baselineMs - optimizedMs) / baselineMs) * 100;
}

export function loadBenchmarks(storage: BenchmarkStorage | undefined = browserStorage()): BenchmarkResult[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(KEY);
    return raw ? (JSON.parse(raw) as BenchmarkResult[]) : [];
  } catch {
    return [];
  }
}

export function saveBenchmark(
  result: BenchmarkResult,
  storage: BenchmarkStorage | undefined = browserStorage(),
  limit = 30,
): BenchmarkResult[] {
  const next = [result, ...loadBenchmarks(storage)].slice(0, limit);
  storage?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearBenchmarks(storage: BenchmarkStorage | undefined = browserStorage()): void {
  storage?.removeItem(KEY);
}

export function latestBaseline(history: BenchmarkResult[], modelId: string | null): BenchmarkResult | undefined {
  return history.find((b) => b.runtime.modelId === modelId && b.presetId === 'safe');
}

function browserStorage(): BenchmarkStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}
