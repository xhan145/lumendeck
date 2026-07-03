import { describe, expect, it } from 'vitest';
import { findAsset, loraCompatible } from '../src/core/shelf';
import { DEMO_SHELF } from '../src/data/demoShelf';

describe('demo shelf', () => {
  it('has checkpoints and loras with full metadata', () => {
    const checkpoints = DEMO_SHELF.filter((a) => a.assetType === 'checkpoint');
    const loras = DEMO_SHELF.filter((a) => a.assetType === 'lora');
    expect(checkpoints.length).toBeGreaterThanOrEqual(4);
    expect(loras.length).toBeGreaterThanOrEqual(6);
    for (const a of DEMO_SHELF) {
      expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(a.path.length).toBeGreaterThan(0);
      expect(a.license.length).toBeGreaterThan(0);
      expect(a.compatibility.length).toBeGreaterThan(0);
      expect(a.tags.length).toBeGreaterThan(0);
    }
  });

  it('includes at least one not-installed asset for health testing', () => {
    expect(DEMO_SHELF.some((a) => !a.installed)).toBe(true);
  });
});

describe('loraCompatible', () => {
  it('accepts same-family pairs', () => {
    const xlLora = findAsset(DEMO_SHELF, 'lora-neon-bloom')!;
    const xlCkpt = findAsset(DEMO_SHELF, 'ckpt-lumen-xl')!;
    expect(loraCompatible(xlLora, xlCkpt).ok).toBe(true);
  });

  it('warns on cross-family pairs', () => {
    const sd15Lora = findAsset(DEMO_SHELF, 'lora-retro-grain')!;
    const xlCkpt = findAsset(DEMO_SHELF, 'ckpt-lumen-xl')!;
    const res = loraCompatible(sd15Lora, xlCkpt);
    expect(res.ok).toBe(false);
    expect(res.warning).toContain('SD1.5');
  });
});
