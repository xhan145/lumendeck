import type { FileEntry, FileKind } from '../../bridge/files';

export type FileSort = 'name' | 'type' | 'modified' | 'size';

export const FILE_GROUPS: ReadonlyArray<{ kind: FileKind; label: string; color: string }> = [
  { kind: 'folder', label: 'Folders', color: '#b6a0ed' },
  { kind: 'image', label: 'Images', color: '#a2aedc' },
  { kind: 'audio', label: 'Audio', color: '#d0a6d8' },
  { kind: 'video', label: 'Video', color: '#9ebfc2' },
  { kind: 'code', label: 'Code', color: '#a4a6ca' },
  { kind: 'document', label: 'Documents', color: '#c6b4d7' },
  { kind: 'file', label: 'Other', color: '#8f9cb1' },
];

export interface FileStar {
  entry: FileEntry;
  x: number;
  y: number;
  z: number;
  color: string;
  group: FileKind;
}

/** Stable, non-destructive projection of real paths into spatial constellations. */
export function makeFileStars(entries: FileEntry[], max = 180): FileStar[] {
  const results: FileStar[] = [];
  const groups = FILE_GROUPS.map((group) => ({
    ...group,
    // View sorting (name/size/date) must never reshuffle constellation
    // coordinates. File identity remains the original physical path.
    members: entries.filter((entry) => entry.kind === group.kind)
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
  })).filter((group) => group.members.length > 0);
  if (!groups.length || max <= 0) return results;

  // Reserve representation for multiple file types before filling remaining
  // stars. A crowded image folder must not completely hide audio/code clusters.
  const initialShare = Math.floor(max / groups.length);
  const allotted = groups.map((group) => Math.min(group.members.length, initialShare));
  let remainder = max - allotted.reduce((sum, count) => sum + count, 0);
  while (remainder > 0) {
    let extended = false;
    for (let i = 0; i < groups.length && remainder > 0; i++) {
      if (allotted[i] < groups[i].members.length) {
        allotted[i]++;
        remainder--;
        extended = true;
      }
    }
    if (!extended) break;
  }

  for (const [groupIndex, group] of groups.entries()) {
    const members = group.members.slice(0, allotted[groupIndex]);
    const angle = -Math.PI / 2 + (groupIndex / groups.length) * Math.PI * 2;
    const distance = 7.4;
    const centerX = Math.cos(angle) * distance;
    const centerY = Math.sin(angle) * distance * 0.67;
    const centerZ = Math.sin(angle * 1.75) * 2.2;
    for (const [index, entry] of members.entries()) {
      const phi = index * 2.399963229728653; // golden angle
      const ring = Math.sqrt(index + 1) * 0.56;
      results.push({
        entry, group: group.kind, color: group.color,
        x: centerX + Math.cos(phi) * ring,
        y: centerY + Math.sin(phi) * ring * 0.78,
        z: centerZ + Math.sin(phi * 0.65) * ring * 0.42,
      });
    }
  }
  return results;
}

export function filterAndSortFiles(entries: FileEntry[], query: string, sort: FileSort): FileEntry[] {
  const q = query.trim().toLocaleLowerCase();
  const visible = q
    ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(q))
    : [...entries];
  return visible.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let compared = 0;
    switch (sort) {
      case 'type': compared = a.kind.localeCompare(b.kind); break;
      case 'size': compared = (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1); break;
      case 'modified': compared = (b.modifiedMs ?? -1) - (a.modifiedMs ?? -1); break;
      default: break;
    }
    return compared || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function humanFileSize(bytes: number | null): string {
  if (bytes === null) return 'Folder';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
