import { describe, expect, it } from 'vitest';
import type { RenderJob } from '../src/bridge/adapter';
import {
  classifyModelCompatibility,
  applyProfileToJob,
  selectOptimizations,
  type CompatibilityInput,
  type HardwareSnapshot,
} from '../src/core/hardware';

const gtx1650: HardwareSnapshot = {
  nvidia: true,
  cuda: true,
  deviceName: 'NVIDIA GeForce GTX 1650',
  totalVramMb: 4096,
  backend: 'diffusers',
  computeCapability: '7.5',
  supportedPrecisions: { fp16: true, bf16: false },
};

function compat(overrides: Partial<CompatibilityInput> = {}): CompatibilityInput {
  return {
    profileId: 'gtx_1650_4gb',
    modelFamily: 'SD1.5',
    isVideo: false,
    controlNetCount: 0,
    loraCount: 0,
    refiner: false,
    upscaler: false,
    ...overrides,
  };
}

describe('model compatibility classification', () => {
  it('recommends SD 1.5 as the baseline on the 4GB profile', () => {
    expect(classifyModelCompatibility(compat()).category).toBe('recommended');
  });

  it('marks SDXL as requiring CPU offload', () => {
    const r = classifyModelCompatibility(compat({ modelFamily: 'SDXL' }));
    expect(r.category).toBe('cpu-offload-required');
    expect(r.reasons.some((x) => /offload/i.test(x))).toBe(true);
  });

  it('escalates SDXL + refiner to high OOM risk', () => {
    expect(classifyModelCompatibility(compat({ modelFamily: 'SDXL', refiner: true })).category).toBe('high-oom-risk');
  });

  it('marks Flux and video workflows as unsupported on the 4GB profile', () => {
    expect(classifyModelCompatibility(compat({ modelFamily: 'Flux' })).category).toBe('unsupported');
    expect(classifyModelCompatibility(compat({ isVideo: true })).category).toBe('unsupported');
  });

  it('downgrades SD 1.5 with many extra networks to compatible-with-limitations', () => {
    expect(classifyModelCompatibility(compat({ controlNetCount: 2 })).category).toBe('compatible-limited');
    expect(classifyModelCompatibility(compat({ loraCount: 3 })).category).toBe('compatible-limited');
  });

  it('classifies by architecture, not file size — SDXL is never "recommended" on 4GB', () => {
    expect(classifyModelCompatibility(compat({ modelFamily: 'SDXL' })).category).not.toBe('recommended');
  });

  it('leaves everything "recommended" on unconstrained profiles (existing behavior, test 23)', () => {
    expect(classifyModelCompatibility(compat({ profileId: 'high_performance', modelFamily: 'Flux', refiner: true, isVideo: true })).category).toBe('recommended');
  });
});

function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    prompt: 'x', negativePrompt: '', seed: 1, resolvedPrompt: 'x', usedWildcards: [],
    steps: 25, cfg: 7, denoise: 1, scheduler: 'karras', width: 1024, height: 1024,
    modelId: 'm', loras: [], sampler: 'euler_a', output: 'image', frameCount: 1, fps: 8,
    motionStrength: 0, cameraMotion: 'orbit', loop: true, format: 'png', denoiseStrength: 0.6,
    hiresScale: 2, hiresDenoise: 0.35, hiresSteps: 14, ...overrides,
  };
}

describe('applyProfileToJob', () => {
  it('clamps resolution to the 4GB max, disables hires, and attaches a low-VRAM directive', () => {
    const out = applyProfileToJob(job(), 'gtx_1650_4gb', gtx1650);
    expect(out.width).toBe(768);
    expect(out.height).toBe(768);
    expect(out.hiresScale).toBe(1);
    expect(out.memoryProfile?.lowVram).toBe(true);
    expect(out.memoryProfile?.precision).toBe('fp16');
    expect(out.memoryProfile?.modelCpuOffload).toBe(true);
  });

  it('does not mutate the input job', () => {
    const input = job();
    applyProfileToJob(input, 'gtx_1650_4gb', gtx1650);
    expect(input.width).toBe(1024);
    expect(input.hiresScale).toBe(2);
  });

  it('preserves resolution and hires on unconstrained profiles, with a legacy (lowVram:false) directive (test 23)', () => {
    const out = applyProfileToJob(job(), 'high_performance', { ...gtx1650, totalVramMb: 16384 });
    expect(out.width).toBe(1024);
    expect(out.height).toBe(1024);
    expect(out.hiresScale).toBe(2);
    expect(out.memoryProfile?.lowVram).toBe(false);
  });

  it('keeps resolution a multiple of 8 after clamping', () => {
    const out = applyProfileToJob(job({ width: 1000, height: 900 }), 'gtx_1650_4gb', gtx1650);
    expect(out.width % 8).toBe(0);
    expect(out.height % 8).toBe(0);
  });

  it('falls back to fp32 in the directive when fp16 is unsupported (test 8)', () => {
    const noFp16 = { ...gtx1650, supportedPrecisions: { fp16: false, bf16: false } };
    expect(applyProfileToJob(job(), 'gtx_1650_4gb', noFp16).memoryProfile?.precision).toBe('fp32');
    // sanity: same via selectOptimizations
    expect(selectOptimizations('gtx_1650_4gb', { hw: noFp16 }).precision).toBe('fp32');
  });
});
