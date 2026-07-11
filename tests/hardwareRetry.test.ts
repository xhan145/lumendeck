import { describe, expect, it } from 'vitest';
import type { RenderJob } from '../src/bridge/adapter';
import {
  classifyBackendError,
  safeRetryConfig,
  planSafeRetry,
  type BackendErrorCategory,
} from '../src/core/hardware';

function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    prompt: 'a private secret prompt',
    negativePrompt: '',
    seed: 42,
    resolvedPrompt: 'a private secret prompt',
    usedWildcards: [],
    steps: 25,
    cfg: 7,
    denoise: 1,
    scheduler: 'karras',
    width: 1024,
    height: 1024,
    modelId: 'sdxl',
    loras: [],
    sampler: 'euler_a',
    output: 'image',
    frameCount: 1,
    fps: 8,
    motionStrength: 0,
    cameraMotion: 'orbit',
    loop: true,
    format: 'png',
    denoiseStrength: 0.6,
    hiresScale: 2,
    hiresDenoise: 0.35,
    hiresSteps: 14,
    ...overrides,
  };
}

describe('backend error classification (tests 16-18)', () => {
  it('detects a CUDA OOM from the canonical torch message', () => {
    expect(classifyBackendError('CUDA out of memory. Tried to allocate 2.00 GiB')).toBe('cuda_oom');
  });

  it('detects OOM during model loading, generation, and VAE decode', () => {
    expect(classifyBackendError('torch.cuda.OutOfMemoryError: CUDA out of memory')).toBe('cuda_oom');
    expect(classifyBackendError('RuntimeError: CUDA out of memory during VAE decode')).toBe('cuda_oom');
    expect(classifyBackendError('CUBLAS_STATUS_ALLOC_FAILED')).toBe('cuda_oom');
  });

  it('does NOT treat unrelated runtime errors as OOM (spec: do not swallow unrelated exceptions)', () => {
    expect(classifyBackendError('FileNotFoundError: model.safetensors is missing')).toBe('other');
    expect(classifyBackendError('ValueError: bad scheduler')).toBe('other');
    expect(classifyBackendError('')).toBe('other');
  });

  it('accepts a pre-categorized errorCategory field verbatim', () => {
    expect(classifyBackendError('anything', 'cuda_oom')).toBe('cuda_oom');
  });
});

describe('safe retry configuration (safe retry section)', () => {
  it('produces a conservative job without mutating the input', () => {
    const original = job();
    const retry = safeRetryConfig(original);
    expect(retry).not.toBe(original);
    expect(original.width).toBe(1024); // input untouched
    expect(original.hiresScale).toBe(2);
    expect(retry.width).toBe(512);
    expect(retry.height).toBe(512);
    expect(retry.hiresScale).toBe(1); // hires fix disabled
  });

  it('enables aggressive memory optimizations and disables previews in the directive', () => {
    const retry = safeRetryConfig(job());
    expect(retry.memoryProfile?.modelCpuOffload).toBe(true);
    expect(retry.memoryProfile?.sequentialCpuOffload).toBe(true);
    expect(retry.memoryProfile?.vaeTiling).toBe(true);
    expect(retry.memoryProfile?.livePreviews).toBe(false);
    expect(retry.memoryProfile?.lowVram).toBe(true);
  });
});

describe('single safe retry (tests 20-21)', () => {
  it('retries once for a CUDA OOM on the first attempt', () => {
    const plan = planSafeRetry(job(), 0, 'cuda_oom');
    expect(plan).not.toBeNull();
    expect(plan?.width).toBe(512);
  });

  it('never retries a second time — no infinite loop (test 20)', () => {
    // attempt 1 means one safe retry already happened.
    expect(planSafeRetry(job(), 1, 'cuda_oom')).toBeNull();
    expect(planSafeRetry(job(), 5, 'cuda_oom')).toBeNull();
  });

  it('does not retry for non-OOM errors', () => {
    expect(planSafeRetry(job(), 0, 'other')).toBeNull();
  });

  it('returns only a transient job override and never any settings object (test 21)', () => {
    const plan = planSafeRetry(job(), 0, 'cuda_oom');
    // The result is a RenderJob — it carries no persisted-settings keys.
    expect(plan && 'hardwareProfile' in plan).toBe(false);
    expect(plan && 'appSettings' in plan).toBe(false);
  });
});

// keep the type import referenced
const _cat: BackendErrorCategory = 'other';
void _cat;
