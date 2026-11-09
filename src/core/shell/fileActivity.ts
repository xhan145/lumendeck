import type { FileEntry } from '../../bridge/files';

export interface FileActivityBucket {
  count: number;
  selected: boolean;
}

/**
 * Distribution of the current directory's real modified dates, not file
 * history or a synthetic waveform. Bounded to 20 bins.
 */
export function modificationHistogram(
  entries: readonly FileEntry[], selectedPath: string | null,
  buckets = 12,
): FileActivityBucket[] {
  const count = Math.max(2, Math.min(20, Math.floor(buckets)));
  const output: FileActivityBucket[] = Array.from({ length: count },
    () => ({ count: 0, selected: false }));
  const valid = entries.filter((e) => e.modifiedMs !== null &&
    Number.isFinite(e.modifiedMs) && e.modifiedMs >= 0);
  if (!valid.length) return output;
  const dates = valid.map((e) => e.modifiedMs as number);
  const first = Math.min(...dates), last = Math.max(...dates);
  const position = (ms: number) =>
    first === last ? Math.floor(count / 2)
      : Math.max(0, Math.min(count - 1, Math.floor((ms - first) / (last - first) * (count - 1))));
  for (const entry of valid) {
    const index = position(entry.modifiedMs as number);
    output[index].count++;
    if (entry.path === selectedPath) output[index].selected = true;
  }
  return output;
}
