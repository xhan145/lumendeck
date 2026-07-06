/**
 * Variation planning — turn a base render into N variations along a single axis
 * (seed, cfg, steps, or wildcard). Pure planning only: this produces patch
 * objects describing WHAT to change per run; the store applies each patch to the
 * sampler/prompt capsule and reuses the existing enqueueRender/enqueueBatch path.
 */

export type VariationAxis = 'seed' | 'cfg' | 'steps' | 'wildcard';

export interface VariationBase {
  seed: number;
  cfg: number;
  steps: number;
}

export interface VariationPlanInput {
  base: VariationBase;
  axis: VariationAxis;
  count: number;
  /** for the 'wildcard' axis: distinct values to sweep (one per variation) */
  wildcardValues?: string[];
}

/**
 * One planned variation. Only the varied field(s) are present besides `index`
 * and a human `label`. For the wildcard axis, `seed` still advances so each pick
 * also renders differently, and `wildcardValue` carries the chosen value.
 */
export interface VariationPatch {
  index: number;
  label: string;
  seed?: number;
  cfg?: number;
  steps?: number;
  wildcardValue?: string;
}

const clampCount = (count: number): number => Math.max(1, Math.min(16, Math.floor(count)));

/** CFG sweep bounds — a sensible, bounded range around typical guidance. */
export const CFG_MIN = 2;
export const CFG_MAX = 12;
/** Steps sweep bounds. */
export const STEPS_MIN = 10;
export const STEPS_MAX = 50;

function sweep(min: number, max: number, count: number, index: number): number {
  if (count <= 1) return min;
  return min + ((max - min) * index) / (count - 1);
}

/**
 * Plan `count` variations along `axis`. Pure — deterministic for a given input.
 * - seed: base.seed + i (a distinct seed per run).
 * - cfg: linear sweep across [CFG_MIN, CFG_MAX], rounded to 0.5.
 * - steps: linear sweep across [STEPS_MIN, STEPS_MAX], rounded to whole steps.
 * - wildcard: one distinct wildcardValue per run (cycled if fewer than count),
 *   with the seed advanced so each render is unique.
 */
export function planVariations(input: VariationPlanInput): VariationPatch[] {
  const count = clampCount(input.count);
  const { base, axis } = input;
  const out: VariationPatch[] = [];

  for (let i = 0; i < count; i++) {
    if (axis === 'seed') {
      const seed = base.seed + i;
      out.push({ index: i, label: `seed ${seed}`, seed });
    } else if (axis === 'cfg') {
      const cfg = Math.round(sweep(CFG_MIN, CFG_MAX, count, i) * 2) / 2;
      out.push({ index: i, label: `cfg ${cfg}`, cfg });
    } else if (axis === 'steps') {
      const steps = Math.round(sweep(STEPS_MIN, STEPS_MAX, count, i));
      out.push({ index: i, label: `steps ${steps}`, steps });
    } else {
      // wildcard
      const values = input.wildcardValues ?? [];
      const value = values.length > 0 ? values[i % values.length] : '';
      const seed = base.seed + i;
      out.push({ index: i, label: value ? `wildcard "${value}"` : `variation ${i + 1}`, wildcardValue: value, seed });
    }
  }

  return out;
}
