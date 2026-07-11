/**
 * OOM classification and the one-time safe retry.
 *
 * Backend OOM is detected precisely (not "every exception is an OOM"), and a
 * safe retry is offered at most once. Everything here is pure and returns a
 * transient job override — it never touches persisted settings.
 */
import type { RenderJob } from '../../bridge/adapter';
import { aggressiveRetryDirective } from './optimizations';
import type { PrecisionPref } from './profiles';

export type BackendErrorCategory = 'cuda_oom' | 'other';

/** Precise CUDA OOM signatures. Kept narrow so unrelated errors are not swallowed. */
const OOM_PATTERNS: RegExp[] = [
  /cuda out of memory/i,
  /out of memory/i,
  /outofmemoryerror/i,
  /cublas_status_alloc_failed/i,
  /hip out of memory/i,
];

/**
 * Classify a backend error message. If the backend already tagged the error with
 * a category, that wins (the worker sets errorCategory for OOM); otherwise the
 * message is matched against known OOM signatures. Anything else is 'other'.
 */
export function classifyBackendError(
  message: string | null | undefined,
  category?: BackendErrorCategory | string,
): BackendErrorCategory {
  if (category === 'cuda_oom' || category === 'other') return category;
  const text = String(message ?? '');
  return OOM_PATTERNS.some((p) => p.test(text)) ? 'cuda_oom' : 'other';
}

/** Build a conservative retry job: 512x512, hires off, aggressive offload directive. */
export function safeRetryConfig(job: RenderJob): RenderJob {
  const precision: PrecisionPref = job.memoryProfile?.precision ?? 'fp16';
  return {
    ...job,
    width: 512,
    height: 512,
    hiresScale: 1,
    memoryProfile: aggressiveRetryDirective(precision),
  };
}

/**
 * Decide whether to perform the single safe retry. Returns a retry job only for
 * a CUDA OOM on the first attempt (attempt === 0). attempt >= 1 means the safe
 * retry already ran, so return null — never an infinite loop.
 */
export function planSafeRetry(
  job: RenderJob,
  attempt: number,
  category: BackendErrorCategory,
): RenderJob | null {
  if (category !== 'cuda_oom') return null;
  if (attempt >= 1) return null;
  return safeRetryConfig(job);
}
