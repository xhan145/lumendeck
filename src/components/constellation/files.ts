import type { ConstellationNode } from './types';

/** Read-only, user-selected folder projection. Never reads file contents or mutates disk. */
export interface FileEntry {
  relativePath: string;
  size: number;
}

const COLORS: [string, string] = ['#9982c9', '#637aaf'];
const MAX_FILES = 200;
const MAX_SEGMENTS = 3;

export function buildFileConstellation(entries: readonly FileEntry[], folderName = 'Selected folder'): ConstellationNode {
  const root: ConstellationNode = {
    id: 'files-selected',
    label: folderName,
    description: 'Read-only preview of files you explicitly selected. No filesystem changes.',
    colors: COLORS,
    type: 'mission',
    status: 'active',
    strength: 0.85,
    children: [],
  };
  const folders = new Map<string, ConstellationNode>([['', root]]);
  let included = 0;
  for (const entry of entries) {
    if (included >= MAX_FILES) break;
    const path = entry.relativePath.replace(/\\/g, '/');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some(p => p === '.' || p === '..') || parts.length > 64) continue;
    // File input's webkitRelativePath includes the selected root folder.
    const segments = parts.length > 1 ? parts.slice(1) : parts;
    if (!segments.length) continue;
    let parent = root;
    let prefix = '';
    const directorySegments = segments.slice(0, -1);
    for (const segment of directorySegments.slice(0, MAX_SEGMENTS - 1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { id: `file-folder:${prefix}`, label: segment, description: 'Folder in selected directory', colors: COLORS, type: 'addon', status: 'active', strength: 0.55, children: [] };
        parent.children!.push(folder);
        folders.set(prefix, folder);
      }
      parent = folder;
    }
    if (directorySegments.length >= MAX_SEGMENTS) {
      // Deep paths collapse to one summary star instead of flooding the scene.
      const id = `file-depth:${prefix}`;
      if (!parent.children!.some(n => n.id === id)) {
        parent.children!.push({ id, label: 'Deeper files', description: 'Switch to Files view for deeper folders.', colors: COLORS, type: 'evidence', status: 'active', strength: 0.3 });
      }
      included++;
      continue;
    }
    const name = segments[segments.length - 1];
    const key = segments.join('/');
    if (!parent.children!.some(n => n.id === `file:${key}`)) {
      parent.children!.push({
        id: `file:${key}`, label: name,
        description: `${Math.max(0, entry.size).toLocaleString('en-US')} bytes · Read-only file reference`,
        colors: COLORS, type: 'evidence', status: 'active', strength: 0.3,
      });
    }
    included++;
  }
  root.description = `${included} file entries mapped (maximum ${MAX_FILES}). Read-only; nothing was uploaded or changed.`;
  return root;
}
