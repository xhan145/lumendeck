import { describe, expect, it } from 'vitest';
import { estimateVramBudget, type MemoryBudgetRequest } from '../src/core/hardware';

/** Baseline safe SD1.5 request on the 4GB profile. */
function baseRequest(overrides: Partial<MemoryBudgetRequest> = {}): MemoryBudgetRequest {
  return {
    profileId: 'gtx_1650_4gb',
    modelFamily: 'SD1.5',
    width: 512,
    height: 512,
    batchSize: 1,
    controlNetCount: 0,
    loraCount: 0,
    vaeMode: 'tiled',
    upscaler: false,
    refiner: false,
    livePreview: false,
    cpuOffload: true,
    ...overrides,
  };
}

describe('memory budget policy', () => {
  it('returns a deterministic result (same input → same output)', () => {
    const a = estimateVramBudget(baseRequest());
    const b = estimateVramBudget(baseRequest());
    expect(a).toEqual(b);
  });

  it('marks a safe SD 1.5 512x512 config as safe with no reasons (test 9)', () => {
    const r = estimateVramBudget(baseRequest());
    expect(r.status).toBe('safe');
    expect(r.estimatedVramMb).toBeGreaterThan(0);
    expect(r.estimatedVramMb).toBeLessThan(4096);
    expect(r.reasons).toEqual([]);
    expect(r.recommendedChanges).toEqual([]);
  });

  it('warns for SDXL on a 4GB GPU and recommends CPU offload (test 10)', () => {
    const r = estimateVramBudget(baseRequest({ modelFamily: 'SDXL', width: 1024, height: 1024 }));
    expect(r.status).toBe('warning');
    expect(r.reasons.some((x) => /SDXL/i.test(x) && /offload/i.test(x))).toBe(true);
    expect(r.recommendedChanges).toContain('Enable model CPU offload');
  });

  it('warns when resolution exceeds the profile limit and recommends 512x512 (test 11)', () => {
    const r = estimateVramBudget(baseRequest({ width: 1024, height: 1024 }));
    expect(r.status).toBe('warning');
    expect(r.reasons.some((x) => /resolution/i.test(x))).toBe(true);
    expect(r.recommendedChanges).toContain('Reduce resolution to 512x512');
  });

  it('warns for batch size greater than one (test 12)', () => {
    const r = estimateVramBudget(baseRequest({ batchSize: 2 }));
    expect(r.status).toBe('warning');
    expect(r.reasons.some((x) => /batch/i.test(x))).toBe(true);
    expect(r.recommendedChanges.some((x) => /batch/i.test(x))).toBe(true);
  });

  it('accounts for multiple ControlNet models (test 13)', () => {
    const one = estimateVramBudget(baseRequest({ controlNetCount: 1 }));
    const two = estimateVramBudget(baseRequest({ controlNetCount: 2 }));
    expect(two.estimatedVramMb).toBeGreaterThan(one.estimatedVramMb);
    expect(two.status).toBe('warning');
    expect(two.reasons.some((x) => /ControlNet/i.test(x))).toBe(true);
    expect(two.recommendedChanges).toContain('Use one ControlNet');
  });

  it('accounts for multiple LoRAs (test 14)', () => {
    const one = estimateVramBudget(baseRequest({ loraCount: 1 }));
    const three = estimateVramBudget(baseRequest({ loraCount: 3 }));
    expect(three.estimatedVramMb).toBeGreaterThan(one.estimatedVramMb);
    expect(three.status).toBe('warning');
    expect(three.reasons.some((x) => /LoRA/i.test(x))).toBe(true);
  });

  it('accounts for a refiner and recommends disabling it (test 15)', () => {
    const without = estimateVramBudget(baseRequest({ modelFamily: 'SDXL', width: 768, height: 768, refiner: false }));
    const withRefiner = estimateVramBudget(baseRequest({ modelFamily: 'SDXL', width: 768, height: 768, refiner: true }));
    expect(withRefiner.estimatedVramMb).toBeGreaterThan(without.estimatedVramMb);
    expect(withRefiner.status).not.toBe('safe');
    expect(withRefiner.reasons.some((x) => /refiner/i.test(x))).toBe(true);
    expect(withRefiner.recommendedChanges).toContain('Disable the refiner');
  });

  it('blocks a configuration that cannot fit even with offload', () => {
    const r = estimateVramBudget(baseRequest({ modelFamily: 'Flux', width: 1024, height: 1024, cpuOffload: false }));
    expect(r.status).toBe('blocked');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('does not nag users on profiles without a VRAM budget (existing behavior preserved, test 23)', () => {
    const hp = estimateVramBudget(baseRequest({ profileId: 'high_performance', modelFamily: 'SDXL', width: 1024, height: 1024, refiner: true, controlNetCount: 2 }));
    expect(hp.status).toBe('safe');
    expect(hp.reasons).toEqual([]);
  });

  it('never claims the estimate is an exact measurement', () => {
    const r = estimateVramBudget(baseRequest());
    expect(r.isEstimate).toBe(true);
  });
});
