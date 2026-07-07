/**
 * Render-space field PROFILE — the honest, curated axis→parameter mapping that
 * turns an orb's 3D position into a parameter controller. See
 * docs/superpowers/specs/2026-07-06-render-space-ghost-controller-design.md.
 *
 * HONEST FRAMING: this is a DETERMINISTIC, curated parameter field, NOT a trained
 * model or learned latent space. The axis→param mapping is chosen by rule from
 * the node kind + model family (+ prompt markers). Every function here is pure
 * and unit-tested; there is no ML, telemetry, or fetch anywhere.
 *
 * A `Bundle` lets ONE spatial axis drive several correlated params at once (e.g.
 * the sampler "Structure" axis moves both cfg and steps together). Each entry
 * carries the [min,max] the axis sweeps that param across; `applyField` maps a
 * normalized coord (0..1) into that range.
 */
import { CAPSULES } from '../capsules';
import type { CapsuleKind, ParamDef } from '../types';
import type { ControlNetFamily } from '../controlnet';

/** One param an axis drives, with the [min,max] the axis sweeps it across. */
export type Bundle = { param: string; min: number; max: number }[];

/** A labeled spatial axis and the param bundle it controls. */
export interface FieldAxis {
  label: string;
  bundle: Bundle;
}

/**
 * Up to three spatial axes for a node. A missing axis means that dimension is
 * inert for this node; an empty `{}` profile means the node has no numeric params
 * to drive at all (ghost disabled with a note in the UI).
 */
export interface FieldProfile {
  x?: FieldAxis;
  y?: FieldAxis;
  z?: FieldAxis;
}

/** Numeric ParamDef range lookup on a capsule; null when absent/non-numeric. */
function paramRange(kind: CapsuleKind, paramId: string): { min: number; max: number } | null {
  const def = CAPSULES[kind]?.params.find((p) => p.id === paramId);
  if (!def || def.kind !== 'number') return null;
  if (typeof def.min !== 'number' || typeof def.max !== 'number' || def.max <= def.min) return null;
  return { min: def.min, max: def.max };
}

/**
 * The seed axis range. `seed` is a numeric value the sampler consumes, but its
 * ParamDef kind is 'seed' (not 'number'), so it needs an explicit range for the
 * "Variation" axis. A modest 0..1000 band sweeps distinct seeds without pretending
 * the whole 2^32 space is meaningfully navigable by hand.
 */
const SEED_RANGE = { min: 0, max: 1000 };

/**
 * Family-adapted CFG range for the sampler "Structure" axis. SD1.5 tolerates a
 * wide guidance range; SD2.1 is a touch narrower; SDXL runs best at lower CFG.
 * Ranges stay WITHIN the capsule's own cfg bounds (1..30) so clamping is a no-op
 * at the ends. Mirrors the family heuristics in controlnet.ts.
 */
function cfgRangeForFamily(family: ControlNetFamily): { min: number; max: number } {
  switch (family) {
    case 'SDXL':
      return { min: 2, max: 12 };
    case 'SD2.1':
      return { min: 3, max: 16 };
    case 'SD1.5':
    default:
      return { min: 3, max: 18 };
  }
}

/** True if the prompt text carries a photo/realism marker (biases fidelity). */
function hasPhotoMarker(promptText?: string): boolean {
  if (!promptText) return false;
  return /photo|photograph|realistic|realism|hyperreal|dslr|lifelike/i.test(promptText);
}

/**
 * Build a bundle entry for `paramId` on `kind`, optionally overriding the range
 * (e.g. family-adapted cfg, prompt-biased denoise, the seed axis). Returns null
 * when the param is missing/non-numeric AND no override was given, so callers can
 * skip it cleanly.
 */
function entry(
  kind: CapsuleKind,
  paramId: string,
  override?: { min: number; max: number },
): { param: string; min: number; max: number } | null {
  const range = override ?? paramRange(kind, paramId);
  if (!range) return null;
  return { param: paramId, min: range.min, max: range.max };
}

/** Drop nulls; return an axis only when at least one bundle entry survived. */
function axis(
  label: string,
  entries: ({ param: string; min: number; max: number } | null)[],
): FieldAxis | undefined {
  const bundle = entries.filter((e): e is { param: string; min: number; max: number } => e !== null);
  return bundle.length > 0 ? { label, bundle } : undefined;
}

/**
 * Generic fallback: take the first up-to-3 numeric ParamDefs (ordered by their
 * declaration in the capsule) and give each its own single-param axis using the
 * ParamDef's own min/max. Used for any kind not in the curated table.
 */
function genericProfile(kind: CapsuleKind): FieldProfile {
  const numeric: ParamDef[] = (CAPSULES[kind]?.params ?? []).filter(
    (p) =>
      p.kind === 'number' &&
      typeof p.min === 'number' &&
      typeof p.max === 'number' &&
      (p.max as number) > (p.min as number),
  );
  const axes: (FieldAxis | undefined)[] = numeric.slice(0, 3).map((p) =>
    axis(p.label, [{ param: p.id, min: p.min as number, max: p.max as number }]),
  );
  const [x, y, z] = axes;
  return prune({ x, y, z });
}

/** Strip undefined axes so an empty profile is exactly `{}` (deep-equal friendly). */
function prune(profile: FieldProfile): FieldProfile {
  const out: FieldProfile = {};
  if (profile.x) out.x = profile.x;
  if (profile.y) out.y = profile.y;
  if (profile.z) out.z = profile.z;
  return out;
}

/**
 * Mean-strength ranges for the racks (LoRA/ControlNet). The rack's aggregate
 * "strength" isn't a ParamDef, so the axis sweeps a synthetic mean bundle over a
 * range that matches the per-slot slider bounds.
 */
const LORA_MEAN_RANGE = { min: -1, max: 2 };
const CONTROL_MEAN_RANGE = { min: 0, max: 2 };

/**
 * Pick a curated FieldProfile for a node.
 *
 * @param nodeKind  capsule kind
 * @param family    model family (from estimateFamilyFromModelId) — adapts ranges
 * @param _params   live node params (reserved for future range biasing; the
 *                  curated table is currently param-value independent)
 * @param promptText optional positive prompt — markers bias the fidelity axis
 *
 * Pure + deterministic: the same inputs always yield the same profile. Nodes with
 * no numeric params return an empty `{}` profile.
 */
export function fieldProfile(
  nodeKind: CapsuleKind,
  family: ControlNetFamily,
  _params: Record<string, unknown>,
  promptText?: string,
): FieldProfile {
  switch (nodeKind) {
    case 'sampler': {
      // Photo/realism prompts pull the low end of denoise up (favor fidelity to
      // the base composition) while keeping full range at the top.
      const denoiseRange = hasPhotoMarker(promptText) ? { min: 0.4, max: 1 } : undefined;
      return prune({
        x: axis('Structure', [
          entry(nodeKind, 'cfg', cfgRangeForFamily(family)),
          entry(nodeKind, 'steps', { min: 12, max: 48 }),
        ]),
        y: axis('Fidelity', [entry(nodeKind, 'denoise', denoiseRange)]),
        // seed's ParamDef kind is 'seed' (not 'number'), so give it an explicit range.
        z: axis('Variation', [entry(nodeKind, 'seed', SEED_RANGE)]),
      });
    }
    case 'imageLoader':
      return prune({
        x: axis('Adherence', [entry(nodeKind, 'strength')]),
      });
    case 'hiresFix':
      return prune({
        x: axis('Detail', [entry(nodeKind, 'scale'), entry(nodeKind, 'denoise')]),
      });
    case 'controlNetRack':
      return prune({
        x: {
          label: 'Control strength',
          bundle: [{ param: 'strength', min: CONTROL_MEAN_RANGE.min, max: CONTROL_MEAN_RANGE.max }],
        },
      });
    case 'loraRack':
      return prune({
        x: {
          label: 'LoRA weight',
          bundle: [{ param: 'weight', min: LORA_MEAN_RANGE.min, max: LORA_MEAN_RANGE.max }],
        },
      });
    default:
      return genericProfile(nodeKind);
  }
}

/** True when a profile drives at least one param (ghost can be spawned). */
export function profileHasAxes(profile: FieldProfile): boolean {
  return !!(profile.x || profile.y || profile.z);
}

/** Flatten every (axis, bundle-entry) pair a profile drives, in x,y,z order. */
export function profileEntries(
  profile: FieldProfile,
): { axis: 'x' | 'y' | 'z'; param: string; min: number; max: number }[] {
  const out: { axis: 'x' | 'y' | 'z'; param: string; min: number; max: number }[] = [];
  for (const key of ['x', 'y', 'z'] as const) {
    const a = profile[key];
    if (!a) continue;
    for (const b of a.bundle) out.push({ axis: key, param: b.param, min: b.min, max: b.max });
  }
  return out;
}
