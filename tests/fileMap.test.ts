import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/bridge/files';
import { filterAndSortFiles, humanFileSize, makeFileStars } from '../src/core/shell/fileMap';

const item = (name: string, kind: FileEntry['kind'], sizeBytes: number | null = 10): FileEntry => ({
  name, path: `C:\\Test\\${name}`, kind,
  extension: kind === 'image' ? 'png' : '',
  isDirectory: kind === 'folder', isSymlink: false, isReadOnly: false,
  sizeBytes: kind === 'folder' ? null : sizeBytes, modifiedMs: 1000,
});

describe('Files constellation projection', () => {
  it('does not mutate filesystem entries or their paths', () => {
    const files = [item('Album', 'folder'), item('cover.png', 'image'), item('song.wav', 'audio')];
    const before = JSON.stringify(files);
    const stars = makeFileStars(files);
    expect(stars).toHaveLength(3);
    expect(stars.map((star) => star.entry.path)).toEqual(files.map((file) => file.path));
    expect(stars.every((star) => Number.isFinite(star.x + star.y + star.z))).toBe(true);
    expect(JSON.stringify(files)).toBe(before);
  });

  it('handles empty and bounded scenes', () => {
    expect(makeFileStars([])).toEqual([]);
    const files = Array.from({ length: 220 }, (_, i) => item(`file-${i}.png`, 'image'));
    expect(makeFileStars(files)).toHaveLength(180);
  });
});

describe('File browser listing utilities', () => {
  it('puts directories first and filters case-insensitively', () => {
    const files = [item('z.wav', 'audio'), item('myFolder', 'folder'), item('A.png', 'image')];
    expect(filterAndSortFiles(files, '', 'name').map((e) => e.name))
      .toEqual(['myFolder', 'A.png', 'z.wav']);
    expect(filterAndSortFiles(files, '.PNG', 'name').map((e) => e.name))
      .toEqual(['A.png']);
  });

  it('formats sizes without inventing sizes for folders', () => {
    expect(humanFileSize(null)).toBe('Folder');
    expect(humanFileSize(1024)).toBe('1.0 KB');
  });
});
