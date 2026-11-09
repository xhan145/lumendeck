/**
 * Explicitly saved spatial views, stored only in the local Tauri WebView.
 * No automatic crawling, synchronization, or recording file-open history.
 */
export interface SpatialCamera {
  position: [number, number, number];
  target: [number, number, number];
}

export interface SpatialBookmark {
  id: string;
  folderPath: string;
  label: string;
  savedAt: number;
  camera: SpatialCamera | null;
}

export const BOOKMARK_STORAGE_KEY = 'lumendeck.files.spatialBookmarks.v1';
export const MAX_SPATIAL_BOOKMARKS = 16;

type BookmarkStorage = Pick<Storage, 'getItem' | 'setItem'>;
const safeVector = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 &&
  value.every((number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 10000);

export function isAbsoluteFolderPath(path: string): boolean {
  return path === '/' || /^\/[\s\S]*$/.test(path) ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
}

export function sameFolderPath(a: string, b: string): boolean {
  const normalize = (path: string) =>
    path.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase();
  return normalize(a) === normalize(b);
}

export function sanitizeBookmark(value: unknown): SpatialBookmark | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (typeof b.id !== 'string' || !/^[a-zA-Z0-9_-]{2,70}$/.test(b.id) ||
    typeof b.folderPath !== 'string' || b.folderPath.length > 2048 ||
    !isAbsoluteFolderPath(b.folderPath) ||
    typeof b.label !== 'string' || !b.label.trim()) return null;
  const cameraValue = b.camera;
  const camera = cameraValue && typeof cameraValue === 'object'
    ? cameraValue as Record<string, unknown> : null;
  const safePosition = camera?.position;
  const safeTarget = camera?.target;
  const validCamera: SpatialCamera | null =
    safeVector(safePosition) && safeVector(safeTarget)
      ? { position: [...safePosition], target: [...safeTarget] } : null;
  return {
    id: b.id,
    folderPath: b.folderPath,
    label: b.label.trim().slice(0, 72),
    savedAt: typeof b.savedAt === 'number' && Number.isFinite(b.savedAt) && b.savedAt > 0
      ? b.savedAt : 0,
    camera: validCamera,
  };
}

export function readSpatialBookmarks(storage: BookmarkStorage | null): SpatialBookmark[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(BOOKMARK_STORAGE_KEY);
    if (!raw || raw.length > 64000) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: SpatialBookmark[] = [];
    for (const candidate of parsed.slice(0, MAX_SPATIAL_BOOKMARKS * 3)) {
      const bookmark = sanitizeBookmark(candidate);
      if (bookmark && !result.some((item) => sameFolderPath(item.folderPath, bookmark.folderPath))) {
        result.push(bookmark);
      }
      if (result.length === MAX_SPATIAL_BOOKMARKS) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function writeSpatialBookmarks(storage: BookmarkStorage | null, bookmarks: SpatialBookmark[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(bookmarks.slice(0, MAX_SPATIAL_BOOKMARKS)));
    return true;
  } catch {
    return false;
  }
}

export function saveSpatialBookmark(
  items: readonly SpatialBookmark[],
  folderPath: string,
  label: string,
  camera: SpatialCamera | null,
  now: number,
): SpatialBookmark[] {
  if (!isAbsoluteFolderPath(folderPath) || !Number.isFinite(now)) return [...items];
  const existing = items.find((item) => sameFolderPath(item.folderPath, folderPath));
  const saved: SpatialBookmark = {
    id: existing?.id ?? `v_${Math.floor(now).toString(36)}_${(items.length + 1).toString(36)}`,
    folderPath,
    label: label.trim().slice(0, 72) || folderPath,
    savedAt: now,
    camera: camera && safeVector(camera.position) && safeVector(camera.target)
      ? { position: [...camera.position], target: [...camera.target] } : null,
  };
  return [saved, ...items.filter((item) => !sameFolderPath(item.folderPath, folderPath))]
    .slice(0, MAX_SPATIAL_BOOKMARKS);
}

export function removeSpatialBookmark(items: readonly SpatialBookmark[], id: string): SpatialBookmark[] {
  return items.filter((item) => item.id !== id);
}
