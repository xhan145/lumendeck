/**
 * applyField — map a ghost's normalized field position to concrete param values.
 *
 * HONEST FRAMING: a deterministic, curated parameter field — NOT a trained model.
 * Pure + unit-tested. Each present axis coord (already normalized to [0,1]) maps
 * into every param in that axis's bundle; `intensity∈[0,1]` scales the displacement
 * from each bundle range's MIDPOINT toward its ends (0 = midpoint, 1 = full range).
 * Values are clamped to [min,max]. `fieldPosition` is the inverse (round-trips).
 */
import type { MotionParamPatch } from '../motion/renderPlan';
import type { FieldProfile } from './fieldProfile';

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/**
 * Resolve a ghost position + intensity into param patches for `nodeId`.
 *
 * For each axis a∈{x,y,z} present in the profile, its coord c=clamp01(pos[a]) sets
 * a target `min + c*(max-min)` for every param in that axis's bundle; intensity
 * lerps from the range midpoint (intensity 0) to that target (intensity 1). A
 * param appearing in more than one axis takes the LAST axis's contribution (axes
 * are applied in x,y,z order; profiles avoid overlap in practice).
 */
export function applyField(
  pos: { x: number; y: number; z: number },
  intensity: number,
  profile: FieldProfile,
  nodeId: string,
): MotionParamPatch[] {
  const k = clamp01(intensity);
  const byParam = new Map<string, MotionParamPatch>();
  const axes: [keyof FieldProfile, number][] = [
    ['x', clamp01(pos.x)],
    ['y', clamp01(pos.y)],
    ['z', clamp01(pos.z)],
  ];
  for (const [axisKey, coord] of axes) {
    const axis = profile[axisKey];
    if (!axis) continue;
    for (const b of axis.bundle) {
      const mid = (b.min + b.max) / 2;
      const target = b.min + coord * (b.max - b.min);
      const value = clamp(mid + k * (target - mid), Math.min(b.min, b.max), Math.max(b.min, b.max));
      byParam.set(b.param, { nodeId, param: b.param, value });
    }
  }
  return [...byParam.values()];
}

/**
 * Inverse of `applyField` at FULL intensity: given the param values (as patches),
 * recover the normalized [0,1] position on each present axis. Uses the FIRST param
 * of each axis's bundle as the axis's representative (bundles move together). A
 * missing value or degenerate range yields 0.5 (the midpoint) for that axis. This
 * round-trips `applyField(pos, 1, profile, nodeId)` for in-range positions.
 */
export function fieldPosition(
  values: MotionParamPatch[],
  profile: FieldProfile,
): { x: number; y: number; z: number } {
  const byParam = new Map<string, number>();
  for (const v of values) byParam.set(v.param, v.value);
  const coordFor = (axisKey: keyof FieldProfile): number => {
    const axis = profile[axisKey];
    if (!axis || axis.bundle.length === 0) return 0.5;
    const b = axis.bundle[0];
    const val = byParam.get(b.param);
    if (val == null || b.max === b.min) return 0.5;
    return clamp01((val - b.min) / (b.max - b.min));
  };
  return { x: coordFor('x'), y: coordFor('y'), z: coordFor('z') };
}

