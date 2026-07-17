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

function to8(value: number): number {
  return Math.max(64, Math.round(value / 8) * 8);
}

/**
 * Clamp a canvas to the profile cap PRESERVING aspect ratio: when the longest
 * side exceeds the cap, both sides scale by the same factor (then snap to
 * multiples of 8). A per-axis clamp would turn 1216x832 into 768x768 —
 * destroying the composition and stretching img2img init images.
 */
function clampCanvas(width: number, height: number, cap: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= cap) return { width: to8(width), height: to8(height) };
  const scale = cap / longest;
  return { width: to8(width * scale), height: to8(height * scale) };
}

/**
 * Constrained = the profile actively reins in jobs (forces offload) or is CPU
 * mode. Only constrained profiles clamp resolution / disable hires; the UI uses
 * this same predicate so it never displays an unenforced limit as active.
 */
export function isConstrainedProfile(profileId: EffectiveProfileId): boolean {
  const profile = getHardwareProfile(profileId);
  return profile.memoryOptimizations.modelCpuOffload || profileId === 'cpu';
}

export function applyProfileToJob(
  job: RenderJob,
  profileId: EffectiveProfileId,
  hw?: HardwareSnapshot | null,
  opts: OptimizationOptions = {},
): RenderJob {
  const profile = getHardwareProfile(profileId);
  const directive = selectOptimizations(profileId, { hw, ...opts });

  if (!isConstrainedProfile(profileId)) {
    return { ...job, memoryProfile: directive };
  }

  const cap = profile.defaults.maxResolution;
  const canvas = clampCanvas(job.width, job.height, cap);
  return {
    ...job,
    width: canvas.width,
    height: canvas.height,
    hiresScale: profile.defaults.hiresFix ? job.hiresScale : 1,
    memoryProfile: directive,
  };
}
