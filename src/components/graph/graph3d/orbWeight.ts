import { CAPSULES } from '../../../core/capsules';
import type { CapsuleKind, ParamDef } from '../../../core/types';

/**
 * Weight -> gradient encoding for the 3D orb node style. PURE: no DOM, no
 * three.js — fully unit-testable (see tests/orbNodes.test.ts).
 *
 * Each capsule kind maps to the ONE number that best characterizes it (its
 * "primary weight"); that value, normalized to 0..1, drives the orb's
 * cool→hot gradient and the equatorial ring-arc sweep.
 */

export interface PrimaryWeight {
  value: number;
  min: number;
  max: number;
  label: string;
}

/** Brand ramp anchors (Ion Cyan → Voltage Violet → Mango Fuse). */
const RAMP_CYAN: [number, number, number] = [0x34, 0xd6, 0xf4];
const RAMP_VIOLET: [number, number, number] = [0x7c, 0x3a, 0xed];
const RAMP_MANGO: [number, number, number] = [0xff, 0x8a, 0x3d];

/** LoRA rack slot weight range — matches the LoraRack slider (min -1, max 2). */
const LORA_SLOT_RANGE = { min: -1, max: 2 };
/** ControlNet rack slot strength range — matches the ControlNetRack slider (0..2). */
const CONTROL_SLOT_RANGE = { min: 0, max: 2 };

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Weight from a named numeric ParamDef of the kind. The live param value wins;
 * an unset/non-numeric param falls back to the ParamDef default. `range`
 * overrides the ParamDef min/max (the spec pins sampler cfg to 0–30).
 */
function fromParam(
  kind: CapsuleKind,
  params: Record<string, unknown>,
  paramId: string,
  range?: { min: number; max: number },
): PrimaryWeight | null {
  const def = CAPSULES[kind].params.find((p) => p.id === paramId);
  if (!def) return null;
  const value = finiteNumber(params[paramId]) ?? finiteNumber(def.default);
  if (value == null) return null;
  const min = range?.min ?? def.min;
  const max = range?.max ?? def.max;
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  return { value, min, max, label: def.label };
}

/** Mean of a numeric field across ENABLED rack slots; null when none apply. */
function fromEnabledSlots(
  slots: unknown,
  field: 'weight' | 'strength',
  range: { min: number; max: number },
  label: string,
): PrimaryWeight | null {
  if (!Array.isArray(slots)) return null;
  const values: number[] = [];
  for (const slot of slots) {
    if (!slot || typeof slot !== 'object') continue;
    const rec = slot as Record<string, unknown>;
    if (rec.enabled !== true) continue;
    const v = finiteNumber(rec[field]);
    if (v != null) values.push(v);
  }
  if (values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { value: mean, min: range.min, max: range.max, label };
}

/** Generic fallback: the kind's first 'number' ParamDef with a usable range. */
function fromFirstNumberParam(kind: CapsuleKind, params: Record<string, unknown>): PrimaryWeight | null {
  const def: ParamDef | undefined = CAPSULES[kind].params.find(
    (p) => p.kind === 'number' && typeof p.min === 'number' && typeof p.max === 'number' && p.max > p.min,
  );
  if (!def) return null;
  return fromParam(kind, params, def.id);
}

/**
 * The one number that best characterizes a capsule (per-kind table from the
 * design spec), or null when the kind carries no meaningful numeric weight
 * (those render as neutral slate orbs).
 */
export function primaryWeight(kind: CapsuleKind, params: Record<string, unknown>): PrimaryWeight | null {
  switch (kind) {
    case 'sampler':
      return fromParam(kind, params, 'cfg', { min: 0, max: 30 });
    case 'imageLoader':
      return fromParam(kind, params, 'strength');
    case 'loraRack':
      return fromEnabledSlots(params.slots, 'weight', LORA_SLOT_RANGE, 'LoRA weight (mean)');
    case 'controlNetRack':
      return fromEnabledSlots(params.slots, 'strength', CONTROL_SLOT_RANGE, 'Control strength (mean)');
    case 'conditioningAverage':
    case 'latentNoise':
    case 'control':
      return fromParam(kind, params, 'strength');
    case 'video':
      return fromParam(kind, params, 'motionStrength');
    case 'hiresFix':
      return fromParam(kind, params, 'denoise');
    default:
      return fromFirstNumberParam(kind, params);
  }
}

/** Normalized primary weight in 0..1 (clamped), or null for weightless kinds. */
export function weightT(kind: CapsuleKind, params: Record<string, unknown>): number | null {
  const pw = primaryWeight(kind, params);
  if (!pw || pw.max <= pw.min) return null;
  return Math.min(1, Math.max(0, (pw.value - pw.min) / (pw.max - pw.min)));
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function mixChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Sample the brand ramp at x in 0..1: a piecewise-linear per-channel sRGB blend
 * with Ion Cyan #34D6F4 at 0, Voltage Violet #7C3AED at 0.5, and Mango Fuse
 * #FF8A3D at 1.
 */
export function rampColor(x: number): string {
  const t = clamp01(x);
  const [from, to, local]: [[number, number, number], [number, number, number], number] =
    t <= 0.5 ? [RAMP_CYAN, RAMP_VIOLET, t * 2] : [RAMP_VIOLET, RAMP_MANGO, t * 2 - 1];
  return toHex([
    mixChannel(from[0], to[0], local),
    mixChannel(from[1], to[1], local),
    mixChannel(from[2], to[2], local),
  ]);
}

/**
 * Three gradient stops [low, mid, high] for an orb at normalized weight t.
 *
 * Interpolation: the orb's vertical gradient spans the half-ramp-wide window
 * [t/2, (1+t)/2] sliding along the cool→hot brand ramp — low is the window
 * bottom ramp(t/2), high is the window top ramp((1+t)/2), and mid is the exact
 * weight color ramp(t). At t=0 the orb reads cool (cyan body, violet crown);
 * at t=1 it reads hot (violet base, mango body).
 */
export function gradientStops(t: number): [string, string, string] {
  const x = clamp01(t);
  return [rampColor(x / 2), rampColor(x), rampColor((1 + x) / 2)];
}

/** Equatorial ring-arc sweep for normalized weight t: t * 2π (t clamped 0..1). */
export function ringAngle(t: number): number {
  return clamp01(t) * 2 * Math.PI;
}
