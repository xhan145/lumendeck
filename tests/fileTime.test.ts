import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/bridge/files';
import { makeFileStars } from '../src/core/shell/fileMap';
import {
  FILE_TIME_DURATION_SECONDS, clampTimeProgress, fileTimeAt,
  fileTimeBounds, projectFileThroughTime,
} from '../src/core/shell/fileTime';

const file = (name: string, modifiedMs: number | null): FileEntry => ({
  name, path: `C:\\Music\\${name}`, extension: 'wav', kind: 'audio',
  isDirectory: false, isSymlink: false, isReadOnly: false,
  sizeBytes: 1024, modifiedMs,
});

describe('fourth-dimensional Files projection', () => {
  const files = [
    file('old.wav', Date.UTC(2022, 0, 1)),
    file('middle.wav', Date.UTC(2023, 6, 1)),
    file('new.wav', Date.UTC(2025, 0, 1)),
    file('undated.wav', null),
  ];

  it('builds an exact observed last-modified date range', () => {
    const bounds = fileTimeBounds(files);
    expect(bounds).toEqual({
      firstMs: Date.UTC(2022, 0, 1), lastMs: Date.UTC(2025, 0, 1),
      datedCount: 3, distinctDates: true,
    });
    expect(fileTimeAt(bounds!, 0)).toBe(bounds!.firstMs);
    expect(fileTimeAt(bounds!, 1)).toBe(bounds!.lastMs);
    expect(FILE_TIME_DURATION_SECONDS).toBeGreaterThan(10);
  });

  it('does not invent dates when files have none or all share one timestamp', () => {
    expect(fileTimeBounds([file('no-time', null)])).toBeNull();
    const bounds = fileTimeBounds([file('one', 1234), file('two', 1234)]);
    expect(bounds?.distinctDates).toBe(false);
    expect(fileTimeAt(bounds!, 0.81)).toBe(1234);
    expect(fileTimeBounds([file('invalid', Number.NaN)])).toBeNull();
  });

  it('moves stars deterministically in space when moving through time', () => {
    const bounds = fileTimeBounds(files);
    const stars = makeFileStars(files);
    const star = stars.find((item) => item.entry.name === 'old.wav')!;
    const early = projectFileThroughTime(star, bounds, 0);
    const late = projectFileThroughTime(star, bounds, 1);
    expect(early).toEqual(projectFileThroughTime(star, bounds, 0));
    expect([early.x, early.y, early.z]).not.toEqual([late.x, late.y, late.z]);
    expect(early.dated).toBe(true);
    expect(star.entry.path).toBe(files[0].path);
    expect(Number.isFinite(late.x + late.y + late.z)).toBe(true);
  });

  it('marks later-modified files without claiming they did not exist', () => {
    const bounds = fileTimeBounds(files);
    const stars = makeFileStars(files);
    const lateFile = stars.find((star) => star.entry.name === 'new.wav')!;
    const undated = stars.find((star) => star.entry.name === 'undated.wav')!;
    expect(projectFileThroughTime(lateFile, bounds, 0).laterModified).toBe(true);
    expect(projectFileThroughTime(lateFile, bounds, 1).laterModified).toBe(false);
    const unknown = projectFileThroughTime(undated, bounds, 0.5);
    expect(unknown.dated).toBe(false);
    expect(unknown.laterModified).toBe(false);
    expect([unknown.x, unknown.y, unknown.z]).toEqual([undated.x, undated.y, undated.z]);
  });

  it('clamps invalid, negative and overflowing playhead positions', () => {
    expect(clampTimeProgress(-100)).toBe(0);
    expect(clampTimeProgress(123)).toBe(1);
    expect(clampTimeProgress(Number.NaN)).toBe(0);
    expect(clampTimeProgress(Infinity)).toBe(0);
  });
});
