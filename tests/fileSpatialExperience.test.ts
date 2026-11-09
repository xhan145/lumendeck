import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/bridge/files';
import {
  BOOKMARK_STORAGE_KEY, MAX_SPATIAL_BOOKMARKS,
  isAbsoluteFolderPath, readSpatialBookmarks, removeSpatialBookmark,
  sameFolderPath, saveSpatialBookmark, writeSpatialBookmarks,
} from '../src/core/shell/fileBookmarks';
import { fileBreadcrumbs } from '../src/core/shell/fileNavigation';
import {
  createMiniMapBounds, findMiniMapStar, projectMiniMapPoint,
  MINI_MAP_WIDTH, MINI_MAP_HEIGHT,
} from '../src/core/shell/fileMiniMap';
import { modificationHistogram } from '../src/core/shell/fileActivity';
import { makeFileStars } from '../src/core/shell/fileMap';

const aFile = (name: string, modifiedMs: number | null): FileEntry => ({
  name, path: 'C:\\Projects\\' + name, extension: 'txt', kind: 'document',
  isDirectory: false, isReadOnly: false, isSymlink: false,
  sizeBytes: 40, modifiedMs,
});

describe('Spatial Experience 1.0: path hierarchy', () => {
  it('produces navigable ancestors from real Windows drive paths', () => {
    expect(fileBreadcrumbs('C:\\Users\\roar\\Documents').map((b) => b.path))
      .toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\roar', 'C:\\Users\\roar\\Documents']);
    expect(fileBreadcrumbs('C:\\').map((b) => b.path)).toEqual(['C:\\']);
  });
  it('preserves network shares and POSIX roots', () => {
    expect(fileBreadcrumbs('\\\\server\\share\\folder').map((b) => b.path))
      .toEqual(['\\\\server\\share\\', '\\\\server\\share\\folder']);
    expect(fileBreadcrumbs('/home/projects').map((b) => b.path))
      .toEqual(['/', '/home', '/home/projects']);
    expect(fileBreadcrumbs('relative/path')).toEqual([]);
  });
});

describe('Spatial Experience 1.0: explicit local bookmarks', () => {
  const path = 'C:\\Users\\roar\\Projects';
  const camera = {
    position: [0, 1, 18] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
  };
  it('validates roots and de-duplicates case-insensitive folder identities', () => {
    expect(isAbsoluteFolderPath(path)).toBe(true);
    expect(isAbsoluteFolderPath('C:Projects')).toBe(false);
    expect(isAbsoluteFolderPath('Projects')).toBe(false);
    expect(isAbsoluteFolderPath('\\\\server\\share\\folder')).toBe(true);
    expect(sameFolderPath(path, 'c:/users/ROAR/projects/')).toBe(true);
  });
  it('saves camera framing without writing files or retaining duplicates', () => {
    const original = saveSpatialBookmark([], path, 'Projects', camera, 1000);
    const changed = saveSpatialBookmark(original, 'c:/Users/roar/Projects/',
      'Renamed view', camera, 2000);
    expect(changed).toHaveLength(1);
    expect(changed[0].savedAt).toBe(2000);
    expect(changed[0].camera).toEqual(camera);
    expect(original[0].savedAt).toBe(1000);
    expect(removeSpatialBookmark(changed, changed[0].id)).toEqual([]);
  });
  it('recovers gracefully from corrupted, huge, or invalid storage', () => {
    let data: string | null = 'corrupt {';
    const storage = {
      getItem: (key: string) => key === BOOKMARK_STORAGE_KEY ? data : null,
      setItem: (_key: string, value: string) => { data = value; },
    };
    expect(readSpatialBookmarks(storage)).toEqual([]);
    const bookmarks = saveSpatialBookmark([], path, 'Projects', camera, 1000);
    expect(writeSpatialBookmarks(storage, bookmarks)).toBe(true);
    expect(readSpatialBookmarks(storage)).toEqual(bookmarks);
    data = JSON.stringify([{ ...bookmarks[0], camera: { position: [1, Infinity, 3], target: [0, 0, 0] } }]);
    expect(readSpatialBookmarks(storage)[0].camera).toBeNull();
    data = 'x'.repeat(64001);
    expect(readSpatialBookmarks(storage)).toEqual([]);
    expect(writeSpatialBookmarks(null, bookmarks)).toBe(false);
    expect(readSpatialBookmarks(null)).toEqual([]);
  });
  it('never exceeds the local bookmark cap', () => {
    let items = saveSpatialBookmark([], 'C:\\Root', 'Root', null, 100);
    for (let i = 0; i < 40; i++) {
      items = saveSpatialBookmark(items, 'C:\\Folder-' + i, 'Folder ' + i, null, i + 101);
    }
    expect(items).toHaveLength(MAX_SPATIAL_BOOKMARKS);
  });
});

describe('Spatial Experience 1.0: top-down map and observed time', () => {
  const entries = [aFile('old.txt', 1000), aFile('new.txt', 2000),
    aFile('undated.txt', null)];
  const stars = makeFileStars(entries);
  it('projects finite, bounded map points from actual star coordinates', () => {
    const bounds = createMiniMapBounds(stars);
    for (const star of stars) {
      const point = projectMiniMapPoint(star.x, star.y, bounds);
      expect(point.x).toBeGreaterThanOrEqual(6);
      expect(point.x).toBeLessThanOrEqual(MINI_MAP_WIDTH - 6);
      expect(point.y).toBeGreaterThanOrEqual(6);
      expect(point.y).toBeLessThanOrEqual(MINI_MAP_HEIGHT - 6);
    }
  });
  it('picks only a nearby real star, otherwise returns null', () => {
    const bounds = createMiniMapBounds(stars);
    const xyz = Float32Array.from(stars.flatMap((s) => [s.x, s.y, s.z]));
    const target = projectMiniMapPoint(stars[0].x, stars[0].y, bounds);
    expect(findMiniMapStar(xyz, target.x, target.y, bounds, 0.5)).toBe(0);
    expect(findMiniMapStar(xyz, -100, -100, bounds)).toBeNull();
  });
  it('uses actual modification dates, not estimated file versions', () => {
    const bars = modificationHistogram(entries, entries[0].path, 12);
    expect(bars).toHaveLength(12);
    expect(bars.reduce((sum, b) => sum + b.count, 0)).toBe(2);
    expect(bars.filter((b) => b.selected)).toHaveLength(1);
    expect(modificationHistogram(entries.map((e) => ({ ...e, modifiedMs: null })), null)
      .reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });
});
