/**
 * Apply a hardware profile to a render job.
 *
 * Constrained profiles (a VRAM budget that forces offload — the 4GB profile, and
 * CPU mode) clamp resolution to the profile max, disable the hires pass, and
 * attach a low-VRAM directive. Unconstrained profiles only attach a legacy
 * (`lowVram:false`) directive and otherwise leave the job untouched, so users who
 * did not opt into a constrained profile see no behavioral change.
 */
import type { RenderJob } from '../../bridge/adapter';
import type { HardwareSnapshot } from './detection';
import { selectOptimizations, type OptimizationOptions } from './optimizations';
import { getHardwareProfile, type EffectiveProfileId } from './profiles';

function clampTo8(value: number, max: number): number {
  const capped = Math.min(value, max);
  return Math.max(64, Math.floor(capped / 8) * 8);
}

export function applyProfileToJob(
  job: RenderJob,
  profileId: EffectiveProfileId,
  hw?: HardwareSnapshot | null,
  opts: OptimizationOptions = {},
): RenderJob {
  const profile = getHardwareProfile(profileId);
  const directive = selectOptimizations(profileId, { hw, ...opts });

  // Constrained = the profile actively reins in the job (forces offload) or CPU
  // mode. Only then do we clamp resolution / disable hires.
  const constrained = profile.memoryOptimizations.modelCpuOffload || profileId === 'cpu';
  if (!constrained) {
    return { ...job, memoryProfile: directive };
  }

  const cap = profile.defaults.maxResolution;
  return {
    ...job,
    width: clampTo8(job.width, cap),
    height: clampTo8(job.height, cap),
    hiresScale: profile.defaults.hiresFix ? job.hiresScale : 1,
    memoryProfile: directive,
  };
}
