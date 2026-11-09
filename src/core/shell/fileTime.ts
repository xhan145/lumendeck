import type { FileEntry } from '../../bridge/files';
import type { FileStar } from './fileMap';
import { stableFileHash } from './fileFx';

/**
 * 4D Files: treat time as a fourth coordinate and project it into the
 * existing 3D layout. This is NOT filesystem history or version recovery:
 * only each currently listed entry's last-modified timestamp is available.
 */
export interface FileTimeBounds {
  firstMs: number;
  lastMs: number;
  datedCount: number;
  distinctDates: boolean;
}

export interface FileTimePoint {
  x: number;
  y: number;
  z: number;
  /** Files with no valid last-modified timestamp are never misdated. */
  dated: boolean;
  /** Last modification occurs after the selected time, not 'file did not exist'. */
  laterModified: boolean;
}

export const FILE_TIME_DURATION_SECONDS = 24;
export const FILE_TIME_STEPS = 1000;

export function fileTimeBounds(entries: readonly FileEntry[]): FileTimeBounds | null {
  let first = Infinity;
  let last = -Infinity;
  let datedCount = 0;
  for (const entry of entries) {
    const ms = entry.modifiedMs;
    if (ms === null || !Number.isFinite(ms) || ms < 0 || ms > 8_640_000_000_000_000) continue;
    datedCount++;
    first = Math.min(first, ms);
    last = Math.max(last, ms);
  }
  if (!datedCount) return null;
  return { firstMs: first, lastMs: last, datedCount, distinctDates: last > first };
}

export function clampTimeProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
}

export function fileTimeAt(bounds: FileTimeBounds, progress: number): number {
  if (!bounds.distinctDates) return bounds.firstMs;
  return bounds.firstMs + (bounds.lastMs - bounds.firstMs) * clampTimeProgress(progress);
}

export function projectFileThroughTime(
  star: FileStar,
  bounds: FileTimeBounds | null,
  progress: number,
): FileTimePoint {
  const timestamp = star.entry.modifiedMs;
  const dated = timestamp !== null && Number.isFinite(timestamp) && timestamp >= 0
    && timestamp <= 8_640_000_000_000_000;
  if (!bounds?.distinctDates || !dated) {
    // Unknown last-modified time is NOT an estimated historical coordinate:
    // leave the star anchored in its ordinary constellation location.
    return { x: star.x, y: star.y, z: star.z, dated, laterModified: false };
  }
  const now = clampTimeProgress(progress);
  const modifiedPosition = Math.min(
    1, Math.max(0, (timestamp! - bounds.firstMs) / (bounds.lastMs - bounds.firstMs)),
  );
  const hash = stableFileHash(star.entry.path);
  const identity = hash / 4294967296;
  const temporalAngle = now * Math.PI * 2 * (0.72 + identity * 0.23)
    + identity * Math.PI * 2 + modifiedPosition * Math.PI * 1.1;
  const radius = 0.62 + identity * 0.44;
  // Spatial motion is a controlled 3D projection of the fourth coordinate.
  // No earlier position is claimed to be a historically observed file location.
  return {
    x: star.x + Math.cos(temporalAngle) * radius,
    y: star.y + Math.sin(temporalAngle) * radius * 0.74,
    z: star.z + (modifiedPosition - now) * 7.2,
    dated,
    laterModified: dated && timestamp! > fileTimeAt(bounds, now),
  };
}
