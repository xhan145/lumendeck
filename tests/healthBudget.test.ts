import { describe, expect, it } from 'vitest';
import { checkHealth, VRAM_BUDGET_GB } from '../src/core/health';
import type { ModelAsset } from '../src/core/shelf';
import type { Workflow } from '../src/core/types';

const sdxl: ModelAsset = {
  id: 'sdxl-1',
  assetType: 'checkpoint',
  name: 'Test SDXL',
  family: 'SDXL',
  path: '/models/sdxl.safetensors',
  hash: 'abc',
  sizeMB: 6500,
  tags: [],
  compatibility: '',
  license: '',
  installed: true,
};

function wfAt(width: number, height: number): Workflow {
  return {
    id: 'wf',
    name: 'test',
    version: 1,
    schemaVersion: 1,
    nodes: [
      { id: 'm', kind: 'model', x: 0, y: 0, params: { assetId: 'sdxl-1' } },
      { id: 'c', kind: 'canvas', x: 0, y: 0, params: { width, height, batch: 1 } },
    ],
    edges: [],
  };
}

describe('profile-aware VRAM budget in checkHealth', () => {
  it('defaults to the 8 GB budget, preserving existing behavior (test 23)', () => {
    // SDXL 768x768 ≈ 6.6 GB — under 8 GB, so no vram-risk at the default budget.
    const issues = checkHealth(wfAt(768, 768), [sdxl]);
    expect(issues.some((i) => i.code === 'vram-risk')).toBe(false);
    expect(VRAM_BUDGET_GB).toBe(8);
  });

  it('flags the same render as a VRAM risk under the 4 GB profile budget', () => {
    const issues = checkHealth(wfAt(768, 768), [sdxl], 4);
    const risk = issues.find((i) => i.code === 'vram-risk');
    expect(risk).toBeDefined();
    expect(risk?.message).toMatch(/4 GB/);
  });

  it('still passes a small SD1.5-sized render under the 4 GB budget', () => {
    const sd15: ModelAsset = { ...sdxl, id: 'sd15', family: 'SD1.5' };
    const wf: Workflow = {
      ...wfAt(512, 512),
      nodes: [
        { id: 'm', kind: 'model', x: 0, y: 0, params: { assetId: 'sd15' } },
        { id: 'c', kind: 'canvas', x: 0, y: 0, params: { width: 512, height: 512, batch: 1 } },
      ],
    };
    // SD1.5 512x512 ≈ 2.75 GB — under 4 GB.
    expect(checkHealth(wf, [sd15], 4).some((i) => i.code === 'vram-risk')).toBe(false);
  });
});
