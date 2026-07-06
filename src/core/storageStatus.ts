import type { GalleryItem } from '../state/store';

export interface GalleryStorageStatus {
  itemCount: number;
  approximateBytes: number;
  approximateLabel: string;
  persistenceMode: 'browser/localStorage';
  plannedDesktopPath: string;
  plannedSubfolders: string[];
  warning: string | null;
}

export const PLANNED_GALLERY_PATH = '%LOCALAPPDATA%\\LumenDeck\\gallery';
export const PLANNED_GALLERY_SUBFOLDERS = ['renders', 'manifests', 'thumbnails'];

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function estimateGalleryStorage(gallery: Pick<GalleryItem, 'dataUrl' | 'manifest'>[]): GalleryStorageStatus {
  const approximateBytes = gallery.reduce((total, item) => {
    const mediaBytes = Math.ceil((item.dataUrl.length * 3) / 4);
    const manifestBytes = new Blob([JSON.stringify(item.manifest)]).size;
    return total + mediaBytes + manifestBytes;
  }, 0);
  return {
    itemCount: gallery.length,
    approximateBytes,
    approximateLabel: bytesLabel(approximateBytes),
    persistenceMode: 'browser/localStorage',
    plannedDesktopPath: PLANNED_GALLERY_PATH,
    plannedSubfolders: PLANNED_GALLERY_SUBFOLDERS,
    warning: gallery.length > 0 || approximateBytes > 1024 * 1024
      ? 'Browser gallery storage is limited. Export important renders and manifests.'
      : null,
  };
}
