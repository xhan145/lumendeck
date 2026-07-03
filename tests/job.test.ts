import { describe, expect, it } from 'vitest';
import { buildRenderJob, resolveSeed } from '../src/bridge/adapter';
import { mulberry32 } from '../src/bridge/mockAdapter';
import type { LoraSlot } from '../src/core/types';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../src/core/workflow';

describe('buildRenderJob', () => {
  it('assembles a job from workflow params', () => {
    let wf = createDefaultWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-drift-15');
    wf = updateNodeParam(wf, findNode(wf, 'canvas')!.id, 'width', 768);
    const slots: LoraSlot[] = [
      { assetId: 'lora-retro-grain', weight: 0.9, enabled: true },
      { assetId: 'lora-paper-cut', weight: 0.5, enabled: false },
    ];
    wf = updateNodeParam(wf, findNode(wf, 'loraRack')!.id, 'slots', slots);

    const job = buildRenderJob(wf);
    expect(job.modelId).toBe('ckpt-drift-15');
    expect(job.width).toBe(768);
    expect(job.loras).toEqual([{ id: 'lora-retro-grain', weight: 0.9 }]);
    expect(job.steps).toBe(28);
    expect(job.sampler).toBe('euler_a');
  });
});

describe('seeds', () => {
  it('resolveSeed passes explicit seeds through and randomizes -1', () => {
    expect(resolveSeed(1234)).toBe(1234);
    const r = resolveSeed(-1, () => 0.5);
    expect(r).toBe(Math.floor(0.5 * 0xffffffff));
  });

  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual([c(), c(), c()]);
  });
});
