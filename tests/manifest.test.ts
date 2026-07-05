import { describe, expect, it } from 'vitest';
import { buildManifest } from '../src/core/manifest';
import type { LoraSlot } from '../src/core/types';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';

describe('buildManifest', () => {
  it('captures prompt, seed, sampler, model, loras, graph version and app version', () => {
    let wf = createDefaultWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'prompt')!.id, 'positive', 'test prompt');
    wf = updateNodeParam(wf, findNode(wf, 'sampler')!.id, 'seed', 42);
    wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-lumen-xl');
    const slots: LoraSlot[] = [
      { assetId: 'lora-neon-bloom', weight: 0.7, enabled: true },
      { assetId: 'lora-inkwash', weight: 0.4, enabled: true },
      { assetId: 'lora-holo-foil', weight: 1.0, enabled: false },
    ];
    wf = updateNodeParam(wf, findNode(wf, 'loraRack')!.id, 'slots', slots);

    const now = new Date('2026-07-02T12:00:00Z');
    const m = buildManifest(wf, DEMO_SHELF, '0.1.0', now);

    expect(m.app).toBe('LumenDeck');
    expect(m.appVersion).toBe('0.1.0');
    expect(m.createdAt).toBe('2026-07-02T12:00:00.000Z');
    expect(m.prompt).toBe('test prompt');
    expect(m.seed).toBe(42);
    expect(m.sampler.name).toBe('euler_a');
    expect(m.model).toMatchObject({ id: 'ckpt-lumen-xl', family: 'SDXL', hash: 'a1b2c3d4e5f60718' });
    expect(m.media).toMatchObject({ type: 'image', format: 'png', frameCount: 24, fps: 8 });
    // disabled slots excluded
    expect(m.loras).toHaveLength(2);
    expect(m.loras[0]).toMatchObject({ id: 'lora-neon-bloom', weight: 0.7 });
    expect(m.graphVersion).toBe(wf.version);
    expect(m.graph.nodes).toHaveLength(10);
  });

  it('handles an empty model selection with null model', () => {
    const m = buildManifest(createDefaultWorkflow(), DEMO_SHELF, '0.1.0', new Date());
    expect(m.model).toBeNull();
  });
});
