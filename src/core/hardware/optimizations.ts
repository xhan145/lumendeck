/**
 * Backend compatibility layer for memory optimizations.
 *
 * Turns a profile's abstract optimization intent into a concrete directive the
 * inference backend can honor. Today the only real backend is the Diffusers
 * bridge worker, which reads a subset of these fields; other backends (mock,
 * cloud, comfy) ignore the directive. This is deliberately the *only* place that
 * decides which optimizations apply, so we never blindly enable every flag.
 */
import { resolvePrecision, type HardwareSnapshot } from './detection';
import { getHardwareProfile, type EffectiveProfileId, type PrecisionPref } from './profiles';

/** The directive attached to a render job and honored by the bridge worker. */
export interface MemoryProfileDirective {
  profileId: EffectiveProfileId;
  /**
   * When false the worker takes its unchanged legacy path (fp16-on-CUDA + always
   * slicing). Only `true` switches the worker to the low-VRAM offload path, so
   * users who did not opt into a constrained profile are byte-for-byte unchanged.
   */
  lowVram: boolean;
  precision: PrecisionPref;
  modelCpuOffload: boolean;
  sequentialCpuOffload: boolean;
  attentionSlicing: boolean;
  vaeSlicing: boolean;
  vaeTiling: boolean;
}

export interface OptimizationOptions {
  hw?: HardwareSnapshot | null;
  /** Escalate to sequential CPU offload (slower, used by the one-time safe retry). */
  sequentialOffload?: boolean;
}

/**
 * Select the concrete optimization directive for a profile + hardware snapshot.
 * `lowVram` is true only for profiles that force offload (the 4GB profile), which
 * is the single switch the worker uses to leave its legacy path.
 */
export function selectOptimizations(
  profileId: EffectiveProfileId,
  opts: OptimizationOptions = {},
): MemoryProfileDirective {
  const profile = getHardwareProfile(profileId);
  const mem = profile.memoryOptimizations;
  const precision = resolvePrecision(profileId, opts.hw);
  const lowVram = mem.modelCpuOffload; // true only for gtx_1650_4gb today
  return {
    profileId,
    lowVram,
    precision,
    modelCpuOffload: mem.modelCpuOffload,
    sequentialCpuOffload: opts.sequentialOffload ? true : mem.sequentialCpuOffload,
    attentionSlicing: mem.attentionSlicing,
    vaeSlicing: mem.vaeSlicing,
    vaeTiling: mem.vaeTiling,
  };
}

/** The most aggressive directive, used by the one-time safe retry after an OOM. */
export function aggressiveRetryDirective(precision: PrecisionPref = 'fp16'): MemoryProfileDirective {
  return {
    profileId: 'gtx_1650_4gb',
    lowVram: true,
    precision,
    modelCpuOffload: true,
    sequentialCpuOffload: true,
    attentionSlicing: true,
    vaeSlicing: true,
    vaeTiling: true,
  };
}
