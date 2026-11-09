import { invoke, isTauri } from '@tauri-apps/api/core';

export type FileKind = 'folder' | 'image' | 'audio' | 'video' | 'code' | 'document' | 'file';

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  extension: string;
  isDirectory: boolean;
  isSymlink: boolean;
  isReadOnly: boolean;
  sizeBytes: number | null;
  modifiedMs: number | null;
}

export interface FileLocation {
  label: string;
  path: string;
  kind: 'home' | 'folder' | 'drive';
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
  skipped: number;
}

/** Match the native allowlist: avoid accidentally executing scripts on open. */
const PASSIVE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'wav', 'mp3', 'flac', 'ogg', 'aiff', 'm4a', 'mid',
  'mp4', 'mov', 'mkv', 'webm', 'avi',
  'txt', 'md', 'pdf', 'rtf', 'docx', 'xlsx', 'pptx',
  'csv', 'log', 'json', 'toml', 'yaml', 'yml',
  'rs', 'ts', 'tsx', 'jsx', 'css', 'go', 'cpp', 'h',
]);

export function canOpenInDefaultApp(entry: FileEntry): boolean {
  return !entry.isDirectory && PASSIVE_EXTENSIONS.has(entry.extension.toLowerCase());
}

export const filesAvailable = () => isTauri();

export const listLocations = (): Promise<FileLocation[]> => invoke('files_locations');

export const listDirectory = (path?: string): Promise<DirectoryListing> =>
  invoke('files_list', { path: path || null });

export const createDirectory = (parent: string, name: string): Promise<void> =>
  invoke('files_create_folder', { parent, name });

export const renameFile = (path: string, newName: string): Promise<void> =>
  invoke('files_rename', { path, newName });

export const openFile = (path: string): Promise<void> =>
  invoke('files_open', { path });

const RASTER_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export function canPreview(entry: FileEntry): boolean {
  return entry.kind === 'image' && !!RASTER_MIME[entry.extension]
    && entry.sizeBytes !== null && entry.sizeBytes <= 3 * 1024 * 1024;
}

/** Caller owns the resulting object URL and must revoke it on unmount. */
export async function getPreviewUrl(entry: FileEntry): Promise<string | null> {
  if (!canPreview(entry)) return null;
  const bytes = await invoke<number[]>('files_preview', { path: entry.path });
  return URL.createObjectURL(new Blob([Uint8Array.from(bytes)], {
    type: RASTER_MIME[entry.extension],
  }));
}
