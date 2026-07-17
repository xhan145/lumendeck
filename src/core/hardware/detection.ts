/**
 * Pure hardware-detection helpers.
 *
 * A `HardwareSnapshot` is whatever the backend could reliably read (see the
 * bridge worker's status() VRAM probe). Everything here is deterministic and
 * name-agnostic: automatic profile selection is driven by VRAM + capability, so
 * a 4 GB card that never says "GTX 1650" still gets the low-VRAM profile.
 */
import {
  getHardwareProfile,
  type EffectiveProfileId,
  type HardwareProfileId,
  type PrecisionPref,
} from './profiles';

export interface HardwareSnapshot {
  /** True when the detected GPU vendor is NVIDIA. */
  nvidia: boolean;
  /** True when torch.cuda.is_available() succeeded. */
  cuda: boolean;
  /** True when CUDA was present but initialization threw. */
  cudaInitFailed?: boolean;
  deviceName?: string;
  /** Total device VRAM in MB, when reliably readable. */
  totalVramMb?: number;
  /** Free device VRAM in MB, when reliably readable. */
  freeVramMb?: number;
  /** Inference backend id, e.g. 'diffusers'. */
  backend?: string;
  /** CUDA compute capability, e.g. '7.5'. */
  computeCapability?: string;
  /** Precision modes the backend confirmed usable. */
  supportedPrecisions?: { fp16?: boolean; bf16?: boolean };
}

export type VramClass = 'low' | 'vram_4gb' | 'mid' | 'high' | 'unknown';

/**
 * Bucket total VRAM. The 4gb window (3.0–5.2 GB) covers a nominal-4096 card
 * minus driver reserve while excluding a 6 GB card. Unknown/zero → 'unknown'.
 */
export function classifyVram(totalVramMb?: number): VramClass {
  if (!totalVramMb || totalVramMb <= 0) return 'unknown';
  if (totalVramMb < 3000) return 'low';
  if (totalVramMb <= 5200) return 'vram_4gb';
  if (totalVramMb < 9000) return 'mid';
  return 'high';
}

/** True when VRAM is in the ~4 GB class (the trigger window for gtx_1650_4gb). */
export function isApproximately4gb(totalVramMb?: number): boolean {
  const cls = classifyVram(totalVramMb);
  return cls === 'vram_4gb' || cls === 'low';
}

/**
 * Deterministically pick the effective profile for a hardware snapshot.
 * AUTO never selects a CONSTRAINED profile without affirmative evidence: an
 * absent snapshot (bridge offline / status not yet fetched), a non-CUDA or
 * non-NVIDIA machine, or unreadable VRAM all resolve to `balanced` — the
 * unconstrained pre-profile default — so users who never touched the setting
 * keep exactly their existing behavior (mock/cloud/comfy renders included).
 * Only a detected ~4 GB (or smaller) NVIDIA CUDA card triggers the low-VRAM
 * profile. `cpu` remains an EXPLICIT user choice, never an auto result.
 */
export function selectAutoProfile(hw: HardwareSnapshot | null | undefined): EffectiveProfileId {
  if (!hw || !hw.cuda || !hw.nvidia || hw.cudaInitFailed) return 'balanced';
  const cls = classifyVram(hw.totalVramMb);
  switch (cls) {
    case 'low':
    case 'vram_4gb':
      return 'gtx_1650_4gb';
    case 'mid':
      return 'balanced';
    case 'high':
      return 'high_performance';
    case 'unknown':
    default:
      // CUDA works but we can't size it — keep the pre-profile default behavior.
      return 'balanced';
  }
}

/**
 * Resolve a user selection to a concrete profile. Explicit profiles pass through
 * (manual selection wins regardless of hardware); `auto` runs detection. A null
 * snapshot (detection failed / bridge offline) resolves `auto` to the
 * unconstrained `balanced` profile — auto must never clamp anything it cannot see.
 */
export function resolveEffectiveProfile(
  selected: HardwareProfileId,
  hw: HardwareSnapshot | null | undefined,
): EffectiveProfileId {
  if (selected === 'auto') return selectAutoProfile(hw);
  return selected;
}

/**
 * Choose a precision for the effective profile. Walks the profile's precision
 * order and returns the first one the hardware confirms it can run; otherwise
 * fp32. bf16 is only ever returned when both the profile lists it AND hardware
 * confirms it — the gtx_1650 profile never lists bf16, so it can never pick it.
 */
export function resolvePrecision(
  profileId: EffectiveProfileId,
  hw: HardwareSnapshot | null | undefined,
): PrecisionPref {
  const order = getHardwareProfile(profileId).precisionOrder;
  // Unknown hardware (no snapshot at all): trust the profile's own first
  // preference. An EXPLICITLY selected 4GB profile with the bridge offline must
  // not silently degrade to fp32 — fp32 doubles memory and mismatches the
  // worker's fp16-loaded ControlNets, defeating the profile's purpose.
  if (!hw) return order[0] ?? 'fp32';
  const cuda = Boolean(hw?.cuda) && !hw?.cudaInitFailed;
  const supports = (p: PrecisionPref): boolean => {
    switch (p) {
      case 'fp32':
        return true; // always available (CPU or GPU)
      case 'fp16':
      case 'mixed':
        return cuda && Boolean(hw?.supportedPrecisions?.fp16);
      case 'bf16':
        return cuda && Boolean(hw?.supportedPrecisions?.bf16);
      default:
        return false;
    }
  };
  for (const p of order) {
    if (supports(p)) return p;
  }
  return 'fp32';
}
