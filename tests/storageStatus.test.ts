import { describe, expect, it } from 'vitest';
import { estimateGalleryStorage, PLANNED_GALLERY_PATH } from '../src/core/storageStatus';

describe('gallery storage estimator', () => {
  it('reports localStorage mode and planned desktop path', () => {
    const status = estimateGalleryStorage([]);

    expect(status.persistenceMode).toBe('browser/localStorage');
    expect(status.plannedDesktopPath).toBe(PLANNED_GALLERY_PATH);
    expect(status.itemCount).toBe(0);
    expect(status.warning).toBeNull();
  });

  it('estimates media and manifest bytes', () => {
    const status = estimateGalleryStorage([
      {
        dataUrl: 'data:image/png;base64,abcd',
        manifest: { app: 'LumenDeck', prompt: 'test' },
      } as never,
    ]);

    expect(status.itemCount).toBe(1);
    expect(status.approximateBytes).toBeGreaterThan(0);
    expect(status.warning).toContain('Browser gallery storage is limited');
  });
});
