/**
 * Auto-Evolve genome core — PURE (no fetch, no Math.random in the snapshot path).
 *
 * A `Genome` is a vector over a fixed list of mutable render knobs (cfg, steps,
 * denoise, seed — the sampler axes). Every operator (`randomGenome`, `mutate`,
 * `crossover`) is deterministic given a seeded rng (mulberry32), and every value
 * is clamped to its knob's [min,max] so a genome can NEVER drive a param out of
 * bounds. `genomeToPatches` turns a genome into the SAME `MotionParamPatch[]` the
 * motion/field paths use, so the store reuses `applyPatches` + `buildRenderJob`.
 *
 * HONEST FRAMING: this is a bounded parameter SEARCH, not a learned model. The
 * objective (CLIP + aesthetic) lives in the bridge scorer; this file only mutates
 * and breeds the render program. See
 * docs/superpowers/specs/2026-07-06-feedback-autoevolve-phase4-design.md.
 */
import type { MotionParamPatch } from '../motion/renderPlan';
import type { ControlNetFamily } from '../controlnet';

/** One mutable render knob and the [min,max] the search sweeps it across. */
export interface KnobDesc {
  param: string;
  min: number;
  max: number;
  /** When true, values are rounded to whole numbers (e.g. steps, seed). */
  integer?: boolean;
  /**
   * Which workflow node this knob writes. 'sampler' (default) for cfg/steps/seed;
   * 'imageLoader' for the img2img `strength` knob (the worker reads denoiseStrength
   * from the Load Image capsule, never the sampler's denoise param).
   */
  node?: 'sampler' | 'imageLoader';
}

/** A genome: one value per knob, index-aligned with the knob list it was made for. */
export type Genome = number[];

/** A scored genome/candidate — `selectTopK` orders by `score` descending. */
export interface Scored {
  score: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Snap a raw value into a knob's bounds (and to an integer when the knob asks). */
export function clampKnob(value: number, knob: KnobDesc): number {
  const lo = Math.min(knob.min, knob.max);
  const hi = Math.max(knob.min, knob.max);
  const v = Number.isFinite(value) ? value : lo;
  const clamped = clamp(v, lo, hi);
  return knob.integer ? Math.round(clamped) : clamped;
}

/**
 * Deterministic 32-bit hash of a string (FNV-1a). Used to seed the run's rng from
 * the prompt so a run is reproducible (spec: seed the rng from prompt/wildcards,
 * never Math.random in the pure search path).
 */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** What the search should mutate — depends on the model + workflow. */
export interface EvolveKnobOptions {
  family?: ControlNetFamily;
  /** Turbo/LCM checkpoints pin guidance to 0 and use very few steps. */
  isTurbo?: boolean;
  /** True when the workflow feeds an init image (img2img) — then strength matters. */
  hasInitImage?: boolean;
}

/**
 * Build ONLY the knobs that actually change the render for this model + workflow,
 * so the search never wastes a dimension on an inert param:
 * - Turbo: guidance is ignored by the backend (pinned 0) and steps are few, so we
 *   drop cfg and sweep steps 1..8 (the effective turbo range) — NOT 8..40, which
 *   the worker would clamp to a constant 8.
 * - Non-turbo: family-adapted cfg (SDXL runs best lower) + steps 8..40.
 * - img2img only: a `strength` knob on the Load Image node (the worker reads
 *   denoiseStrength from there; the sampler's `denoise` param is never read, so it
 *   is deliberately NOT a knob).
 * - seed is always mutable.
 * Ranges sit within each capsule's own bounds so clamping is a no-op at the ends.
 */
export function buildEvolveKnobs(opts: EvolveKnobOptions | ControlNetFamily = {}): KnobDesc[] {
  const o: EvolveKnobOptions = typeof opts === 'string' ? { family: opts } : opts;
  const { family = 'SD1.5', isTurbo = false, hasInitImage = false } = o;
  const knobs: KnobDesc[] = [];
  if (isTurbo) {
    knobs.push({ param: 'steps', min: 1, max: 8, integer: true });
  } else {
    const cfg =
      family === 'SDXL' ? { min: 2, max: 12 } : family === 'SD2.1' ? { min: 3, max: 14 } : { min: 3, max: 16 };
    knobs.push({ param: 'cfg', min: cfg.min, max: cfg.max });
    knobs.push({ param: 'steps', min: 8, max: 40, integer: true });
  }
  if (hasInitImage) {
    knobs.push({ param: 'strength', min: 0.3, max: 0.9, node: 'imageLoader' });
  }
  knobs.push({ param: 'seed', min: 0, max: 1_000_000, integer: true });
  return knobs;
}

/** A fresh random genome: each gene drawn uniformly in its knob's bounds. */
export function randomGenome(knobs: KnobDesc[], rng: () => number): Genome {
  return knobs.map((k) => {
    const lo = Math.min(k.min, k.max);
    const hi = Math.max(k.min, k.max);
    return clampKnob(lo + rng() * (hi - lo), k);
  });
}

/**
 * Mutate a genome: perturb every gene by up to ±`rate`·range (uniform), clamped to
 * bounds. `rate` is the mutation magnitude in [0,1]; `rate = 0` returns an
 * equivalent genome (no perturbation). Deterministic given `rng`; never escapes
 * `[min,max]`. Extra/missing genes are handled by the knob list length.
 */
export function mutate(genome: Genome, knobs: KnobDesc[], rate: number, rng: () => number): Genome {
  const r = clamp(Number.isFinite(rate) ? rate : 0, 0, 1);
  return knobs.map((k, i) => {
    const span = Math.abs(k.max - k.min);
    const base = genome[i] ?? (k.min + k.max) / 2;
    const delta = (rng() * 2 - 1) * r * span;
    return clampKnob(base + delta, k);
  });
}

/**
 * Uniform crossover: each gene is taken from parent `a` or parent `b` with equal
 * probability (deterministic given `rng`). The child has one gene per knob and is
 * re-clamped so a malformed parent can never produce an out-of-bounds child.
 */
export function crossover(a: Genome, b: Genome, knobs: KnobDesc[], rng: () => number): Genome {
  return knobs.map((k, i) => {
    const from = rng() < 0.5 ? a[i] : b[i];
    const fallback = from ?? a[i] ?? b[i] ?? (k.min + k.max) / 2;
    return clampKnob(fallback, k);
  });
}

/** Node ids a genome writes to. `imageLoader` may be absent (no img2img node). */
export interface GenomeNodes {
  sampler: string;
  imageLoader?: string;
}

/**
 * Convert a genome into param patches, routing each knob to the node it targets
 * (`sampler` by default, `imageLoader` for the img2img strength knob). Index-aligned
 * with `knobs`; values are clamped so patches are always safe to apply. A knob whose
 * target node id is missing is skipped (never a patch to a nonexistent node).
 * Accepts a bare sampler id string for back-compat.
 */
export function genomeToPatches(
  genome: Genome,
  knobs: KnobDesc[],
  nodes: GenomeNodes | string,
): MotionParamPatch[] {
  const map: GenomeNodes = typeof nodes === 'string' ? { sampler: nodes } : nodes;
  const out: MotionParamPatch[] = [];
  knobs.forEach((k, i) => {
    const nodeId = k.node === 'imageLoader' ? map.imageLoader : map.sampler;
    if (!nodeId) return;
    out.push({ nodeId, param: k.param, value: clampKnob(genome[i] ?? k.min, k) });
  });
  return out;
}

/**
 * Select the top `k` scored items by `score` DESCENDING (stable for equal scores).
 * Returns a new array; `k` is clamped to `[0, list.length]`. Does not mutate input.
 */
export function selectTopK<T extends Scored>(scored: T[], k: number): T[] {
  const n = clamp(Math.floor(Number.isFinite(k) ? k : 0), 0, scored.length);
  // Decorate-sort-undecorate keeps the sort stable across engines (equal scores
  // keep their original relative order).
  return scored
    .map((item, index) => ({ item, index }))
    .sort((x, y) => (y.item.score - x.item.score) || (x.index - y.index))
    .slice(0, n)
    .map((d) => d.item);
}

/** Objective weights: how much CLIP vs. aesthetic contribute to a candidate score. */
export interface EvolveWeights {
  clip: number;
  aesthetic: number;
}

/**
 * Renormalize objective weights to sum to 1. When CLIP is unavailable its weight
 * is ZEROED and the whole budget goes to aesthetics (the honest degraded path —
 * never a fabricated CLIP number). If both weights are non-positive, fall back to
 * an even split (or full aesthetic when CLIP is off) so a score is always defined.
 */
export function renormalizeWeights(weights: EvolveWeights, clipAvailable: boolean): EvolveWeights {
  const clipRaw = clipAvailable ? Math.max(0, weights.clip) : 0;
  const aesRaw = Math.max(0, weights.aesthetic);
  const total = clipRaw + aesRaw;
  if (total <= 0) return clipAvailable ? { clip: 0.5, aesthetic: 0.5 } : { clip: 0, aesthetic: 1 };
  return { clip: clipRaw / total, aesthetic: aesRaw / total };
}
