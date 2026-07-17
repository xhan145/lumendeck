import { describe, expect, it } from 'vitest';
import {
  HARDWARE_PROFILE_IDS,
  getHardwareProfile,
  classifyVram,
  selectAutoProfile,
  resolveEffectiveProfile,
  resolvePrecision,
  type HardwareSnapshot,
} from '../src/core/hardware';

/** A GTX 1650 laptop card: ~4 GB, CUDA up, fp16 ok, bf16 NOT supported. */
const gtx1650: HardwareSnapshot = {
  nvidia: true,
  cuda: true,
  cudaInitFailed: false,
  deviceName: 'NVIDIA GeForce GTX 1650',
  totalVramMb: 4096,
  freeVramMb: 3600,
  backend: 'diffusers',
  computeCapability: '7.5',
  supportedPrecisions: { fp16: true, bf16: false },
};

describe('hardware profile registry', () => {
  it('exposes the five selectable profile ids including gtx_1650_4gb', () => {
    expect(HARDWARE_PROFILE_IDS).toEqual([
      'auto',
      'gtx_1650_4gb',
      'balanced',
      'high_performance',
      'cpu',
    ]);
  });

  it('defines the gtx_1650_4gb profile with the exact stable id, name, and description', () => {
    const p = getHardwareProfile('gtx_1650_4gb');
    expect(p.id).toBe('gtx_1650_4gb');
    expect(p.name).toBe('GTX 1650 4GB');
    expect(p.description).toBe(
      'Low-VRAM settings optimized for NVIDIA GTX 1650-class GPUs. Prioritizes stable local generation and avoids GPU memory crashes.',
    );
  });

  it('gives gtx_1650_4gb the conservative generation defaults', () => {
    const d = getHardwareProfile('gtx_1650_4gb').defaults;
    expect(d.batchSize).toBe(1);
    expect(d.concurrentGenerations).toBe(1);
    expect(d.parallelModelLoading).toBe(false);
    expect(d.defaultResolution).toBe(512);
    expect(d.maxResolution).toBe(768);
    expect(d.hiresFix).toBe(false);
    expect(d.autoUnloadInactive).toBe(true);
    expect(d.preloadCheckpoints).toBe(false);
    expect(d.keepSingleModelOnGpu).toBe(true);
    expect(d.modelCacheSize).toBe(1);
    expect(getHardwareProfile('gtx_1650_4gb').vramBudgetMb).toBe(4096);
  });

  it('does not put bf16 anywhere in the gtx_1650 precision order', () => {
    expect(getHardwareProfile('gtx_1650_4gb').precisionOrder).not.toContain('bf16');
  });

  it('keeps existing (non-gtx) profiles free of forced CPU offload', () => {
    expect(getHardwareProfile('balanced').memoryOptimizations.modelCpuOffload).toBe(false);
    expect(getHardwareProfile('high_performance').memoryOptimizations.modelCpuOffload).toBe(false);
    // the 4GB profile is the one that forces offload
    expect(getHardwareProfile('gtx_1650_4gb').memoryOptimizations.modelCpuOffload).toBe(true);
  });
});

describe('VRAM classification', () => {
  it('classifies a 4 GB card as the 4gb bucket', () => {
    expect(classifyVram(4096)).toBe('vram_4gb');
    expect(classifyVram(3800)).toBe('vram_4gb');
  });

  it('classifies a 6 GB card as mid, not 4gb', () => {
    expect(classifyVram(6144)).toBe('mid');
  });

  it('classifies tiny cards as low and big cards as high', () => {
    expect(classifyVram(2048)).toBe('low');
    expect(classifyVram(12288)).toBe('high');
  });

  it('treats unknown/zero VRAM as unknown', () => {
    expect(classifyVram(0)).toBe('unknown');
    expect(classifyVram(undefined)).toBe('unknown');
  });
});

describe('automatic profile selection (test 4, 6, 7)', () => {
  it('selects gtx_1650_4gb for a ~4 GB NVIDIA GPU with CUDA up', () => {
    expect(selectAutoProfile(gtx1650)).toBe('gtx_1650_4gb');
  });

  it('selects gtx_1650_4gb by VRAM+capability, NOT by device name (test 5)', () => {
    // A different NVIDIA 4 GB card (name never mentions "GTX 1650").
    const rtxA2000: HardwareSnapshot = { ...gtx1650, deviceName: 'NVIDIA RTX A2000 Laptop GPU' };
    expect(selectAutoProfile(rtxA2000)).toBe('gtx_1650_4gb');
  });

  it('selects the UNCONSTRAINED balanced profile when CUDA is unavailable (test 6)', () => {
    // Auto must never constrain without affirmative low-VRAM evidence: a
    // non-CUDA machine keeps existing behavior; CPU Mode is explicit-only.
    const noCuda: HardwareSnapshot = { ...gtx1650, cuda: false, nvidia: false };
    expect(selectAutoProfile(noCuda)).toBe('balanced');
  });

  it('selects balanced when CUDA initialization failed (test 7)', () => {
    const initFail: HardwareSnapshot = { ...gtx1650, cudaInitFailed: true };
    expect(selectAutoProfile(initFail)).toBe('balanced');
  });

  it('selects balanced for a healthy 8 GB GPU and high_performance for 16 GB', () => {
    expect(selectAutoProfile({ ...gtx1650, totalVramMb: 8192 })).toBe('balanced');
    expect(selectAutoProfile({ ...gtx1650, totalVramMb: 16384 })).toBe('high_performance');
  });

  it('falls back to balanced (existing behavior) when CUDA is up but VRAM is unreadable', () => {
    expect(selectAutoProfile({ ...gtx1650, totalVramMb: undefined, freeVramMb: undefined })).toBe('balanced');
  });
});

describe('effective profile resolution', () => {
  it('resolves an explicit profile to itself without touching hardware', () => {
    expect(resolveEffectiveProfile('gtx_1650_4gb', gtx1650)).toBe('gtx_1650_4gb');
    // manual selection wins even on a big GPU
    expect(resolveEffectiveProfile('gtx_1650_4gb', { ...gtx1650, totalVramMb: 24000 })).toBe('gtx_1650_4gb');
  });

  it('resolves auto through hardware detection', () => {
    expect(resolveEffectiveProfile('auto', gtx1650)).toBe('gtx_1650_4gb');
  });

  it('resolves auto to UNCONSTRAINED balanced when detection is unavailable (test 24: startup without GPU)', () => {
    expect(resolveEffectiveProfile('auto', null)).toBe('balanced');
  });
});

describe('precision resolution (test 8: unsupported precision fallback)', () => {
  it('picks fp16 on a GTX 1650 where fp16 is supported', () => {
    expect(resolvePrecision('gtx_1650_4gb', gtx1650)).toBe('fp16');
  });

  it('falls back to fp32 when fp16 is not reliably supported', () => {
    const noFp16: HardwareSnapshot = { ...gtx1650, supportedPrecisions: { fp16: false, bf16: false } };
    expect(resolvePrecision('gtx_1650_4gb', noFp16)).toBe('fp32');
  });

  it('falls back to fp32 on CPU (no CUDA)', () => {
    const cpu: HardwareSnapshot = { ...gtx1650, cuda: false, nvidia: false, supportedPrecisions: { fp16: false, bf16: false } };
    expect(resolvePrecision('cpu', cpu)).toBe('fp32');
  });

  it('never selects bf16 for the gtx_1650 profile even if hardware claims support', () => {
    const claimsBf16: HardwareSnapshot = { ...gtx1650, supportedPrecisions: { fp16: true, bf16: true } };
    expect(resolvePrecision('gtx_1650_4gb', claimsBf16)).toBe('fp16');
  });
});
