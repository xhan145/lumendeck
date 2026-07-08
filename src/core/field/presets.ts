/**
 * Field PRESETS — 10 curated, user-editable maps from an orb/ghost's X, Y AND Z
 * position onto distinct render-parameter bundles, plus the pure helpers that
 * drive them. See docs/superpowers/specs/2026-07-07-field-presets-streaming-
 * preview-design.md.
 *
 * HONEST FRAMING: a preset is a DETERMINISTIC, curated parameter field — NOT a
 * trained latent space. Every function here is pure and unit-tested; there is no
 * ML, telemetry, or fetch anywhere.
 *
 * HARD GUARANTEE: every builtin preset binds a NON-EMPTY bundle to all three
 * axes (x, y AND z). `presetAxesUsed` is the pure validator a test asserts on all
 * ten, and the editor requires all three before a custom preset can be saved.
 */
import type { FieldAxis, FieldProfile } from './fieldProfile';

/** The six capsule kinds an axis bundle can drive (a subset of CapsuleKind). */
export type PresetNodeKind =
  | 'sampler'
  | 'imageLoader'
  | 'hiresFix'
  | 'controlNetRack'
  | 'loraRack'
  | 'video';

/** One parameter an axis drives, with the [min,max] the axis sweeps it across. */
export interface AxisParam {
  node: PresetNodeKind;
  param: string;
  min: number;
  max: number;
}

/** A labeled spatial axis and the one-or-more params it sweeps together. */
export interface AxisBundle {
  label: string;
  params: AxisParam[];
}

/**
 * A curated field preset. `description` is optional so the editor can build a
 * draft preset (name + axes only) to validate before naming; every builtin sets
 * it. `builtin` flags the ten shipped presets (deleting one HIDES it, see the
 * store + persistence, rather than hard-deleting the definition).
 */
export interface FieldPreset {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  axes: { x: AxisBundle; y: AxisBundle; z: AxisBundle };
}

/** One resolved patch: set `param` on the FIRST node of `node` kind to `value`. */
export interface PresetPatch {
  node: PresetNodeKind;
  param: string;
  value: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/** Terse builtin-axis constructor. */
function P(node: PresetNodeKind, param: string, min: number, max: number): AxisParam {
  return { node, param, min, max };
}

/**
 * A modest seed band. `seed` is numeric but not a slider; 0..1000 sweeps distinct
 * seeds without pretending the whole 2^32 space is hand-navigable (mirrors the
 * v0.16 fieldProfile SEED_RANGE).
 */
const SEED = (): AxisParam => P('sampler', 'seed', 0, 1000);

/**
 * The ten curated presets. Each binds a NON-EMPTY bundle to x, y AND z using ONLY
 * params the render actually consumes: cfg/steps/denoise/seed on the sampler,
 * strength on the Load Image (img2img), scale/denoise/steps on Hires Fix, a mean
 * control strength on the ControlNet rack and a mean LoRA weight on the LoRA rack
 * (both fanned out to their enabled slots — see rackFanout.ts). NO preset drives
 * the Video node: its params only affect a render when video is enabled, so they
 * would be silently inert on a still preview.
 */
export const BUILTIN_FIELD_PRESETS: FieldPreset[] = [
  {
    id: 'builtin-classic-sampler',
    name: 'Classic Sampler',
    description: 'The everyday triad: guidance+steps structure, denoise fidelity, and seed variation.',
    builtin: true,
    axes: {
      x: { label: 'Structure', params: [P('sampler', 'cfg', 3, 18), P('sampler', 'steps', 12, 48)] },
      y: { label: 'Fidelity', params: [P('sampler', 'denoise', 0, 1)] },
      z: { label: 'Variation', params: [SEED()] },
    },
  },
  {
    id: 'builtin-cfg-explorer',
    name: 'CFG Explorer',
    description: 'Isolate guidance, steps, and seed on their own axes to map how each moves the image.',
    builtin: true,
    axes: {
      x: { label: 'Guidance', params: [P('sampler', 'cfg', 1, 20)] },
      y: { label: 'Steps', params: [P('sampler', 'steps', 8, 60)] },
      z: { label: 'Variation', params: [SEED()] },
    },
  },
  {
    id: 'builtin-img2img-morph',
    name: 'img2img Morph',
    description: 'Sweep img2img denoise strength against guidance and seed to morph a source image.',
    builtin: true,
    axes: {
      x: { label: 'Strength', params: [P('imageLoader', 'strength', 0, 1)] },
      y: { label: 'Guidance', params: [P('sampler', 'cfg', 2, 14)] },
      z: { label: 'Variation', params: [SEED()] },
    },
  },
  {
    id: 'builtin-detail-upscale',
    name: 'Detail & Upscale',
    description: 'Hires-fix space: upscale factor, hires denoise detail, and hires steps.',
    builtin: true,
    axes: {
      x: { label: 'Upscale', params: [P('hiresFix', 'scale', 1, 4)] },
      y: { label: 'Detail', params: [P('hiresFix', 'denoise', 0, 1)] },
      z: { label: 'Steps', params: [P('hiresFix', 'steps', 4, 40)] },
    },
  },
  {
    id: 'builtin-controlnet-balance',
    name: 'ControlNet Balance',
    description: 'Trade control-guidance strength against CFG and seed to balance structure vs. freedom.',
    builtin: true,
    axes: {
      x: { label: 'Control', params: [P('controlNetRack', 'strength', 0, 2)] },
      y: { label: 'Guidance', params: [P('sampler', 'cfg', 2, 14)] },
      z: { label: 'Variation', params: [SEED()] },
    },
  },
  {
    id: 'builtin-lora-blend',
    name: 'LoRA Blend',
    description: 'Sweep mean LoRA weight against guidance and seed to dial adapter influence.',
    builtin: true,
    axes: {
      x: { label: 'LoRA weight', params: [P('loraRack', 'weight', -1, 2)] },
      y: { label: 'Guidance', params: [P('sampler', 'cfg', 2, 14)] },
      z: { label: 'Variation', params: [SEED()] },
    },
  },
  {
    id: 'builtin-chaos',
    name: 'Chaos',
    description: 'Wide-open exploration: full seed, guidance, and step ranges for broad sampling.',
    builtin: true,
    axes: {
      x: { label: 'Variation', params: [SEED()] },
      y: { label: 'Guidance', params: [P('sampler', 'cfg', 1, 30)] },
      z: { label: 'Steps', params: [P('sampler', 'steps', 1, 150)] },
    },
  },
  {
    id: 'builtin-fine-tune',
    name: 'Fine-Tune',
    description: 'Narrow ranges around a good default for careful guidance/steps/denoise nudges.',
    builtin: true,
    axes: {
      x: { label: 'Guidance', params: [P('sampler', 'cfg', 5, 9)] },
      y: { label: 'Steps', params: [P('sampler', 'steps', 22, 34)] },
      z: { label: 'Denoise', params: [P('sampler', 'denoise', 0.8, 1)] },
    },
  },
  {
    id: 'builtin-style-structure',
    name: 'Style & Structure',
    description: 'LoRA adapter influence against guidance and steps — all still-image params the render consumes.',
    builtin: true,
    axes: {
      // LoRA weight is fanned out to every enabled rack slot (see rackFanout.ts),
      // so this axis really moves a still preview — never the dead aggregate.
      x: { label: 'LoRA weight', params: [P('loraRack', 'weight', -1, 2)] },
      y: { label: 'Guidance', params: [P('sampler', 'cfg', 2, 14)] },
      z: { label: 'Steps', params: [P('sampler', 'steps', 12, 48)] },
    },
  },
  {
    id: 'builtin-hifi-portrait',
    name: 'Hi-Fi Portrait',
    description: 'Portrait-leaning ranges: moderate guidance, subtle hires detail, ample steps.',
    builtin: true,
    axes: {
      x: { label: 'Guidance', params: [P('sampler', 'cfg', 3, 9)] },
      y: { label: 'Detail', params: [P('hiresFix', 'denoise', 0.2, 0.6)] },
      z: { label: 'Steps', params: [P('sampler', 'steps', 24, 48)] },
    },
  },
];

/**
 * The headline guarantee, as a pure predicate: a preset uses all three axes iff
 * x, y AND z each bind at least one parameter. The editor gates Save on this and
 * a test asserts it for every builtin.
 */
export function presetAxesUsed(preset: Pick<FieldPreset, 'axes'>): boolean {
  const a = preset.axes;
  return a.x.params.length > 0 && a.y.params.length > 0 && a.z.params.length > 0;
}

/**
 * Resolve an orb/ghost position + intensity into generic param patches (node KIND
 * + param + value); the store maps each kind → the concrete node id.
 *
 * For each axis a∈{x,y,z}, its coord c=clamp01(pos[a]) sets a target
 * `min + c*(max-min)` for every param in that axis's bundle; `intensity∈[0,1]`
 * lerps from the range MIDPOINT (0) to that target (1). Values are clamped to the
 * bundle's [min,max]. A (node,param) appearing on more than one axis takes the
 * LAST axis's value (x,y,z order). Pure + deterministic.
 */
export function applyPresetAxes(
  preset: FieldPreset,
  pos: { x: number; y: number; z: number },
  intensity: number,
): PresetPatch[] {
  const k = clamp01(intensity);
  const byKey = new Map<string, PresetPatch>();
  const axes: [AxisBundle, number][] = [
    [preset.axes.x, clamp01(pos.x)],
    [preset.axes.y, clamp01(pos.y)],
    [preset.axes.z, clamp01(pos.z)],
  ];
  for (const [axis, coord] of axes) {
    for (const b of axis.params) {
      const lo = Math.min(b.min, b.max);
      const hi = Math.max(b.min, b.max);
      const mid = (b.min + b.max) / 2;
      const target = b.min + coord * (b.max - b.min);
      const value = clamp(mid + k * (target - mid), lo, hi);
      byKey.set(`${b.node}:${b.param}`, { node: b.node, param: b.param, value });
    }
  }
  return [...byKey.values()];
}

/**
 * Adapt a preset into a v0.16 `FieldProfile` so the SAME `applyField` path (used
 * by the ghost drag + orb gradient) can consume a preset. When `nodeKind` is
 * given, only the axis params that drive THAT kind are kept (so a single-node
 * ghost writes just the params it owns and never pollutes a node with a foreign
 * param); an axis with no matching params is dropped. With no `nodeKind` the full
 * axis bundles are flattened (dropping the node tag). Pure + deterministic.
 */
export function fieldProfileFromPreset(preset: FieldPreset, nodeKind?: string): FieldProfile {
  const build = (bundle: AxisBundle): FieldAxis | undefined => {
    const params = bundle.params
      .filter((b) => nodeKind == null || b.node === nodeKind)
      .map((b) => ({ param: b.param, min: b.min, max: b.max }));
    return params.length > 0 ? { label: bundle.label, bundle: params } : undefined;
  };
  const out: FieldProfile = {};
  const x = build(preset.axes.x);
  const y = build(preset.axes.y);
  const z = build(preset.axes.z);
  if (x) out.x = x;
  if (y) out.y = y;
  if (z) out.z = z;
  return out;
}

/**
 * Flag preset params the CURRENT model/workflow ignores, so the UI can say "this
 * axis won't affect this render" instead of silently doing nothing (reuses the
 * auto-evolve/genome lesson):
 *  - turbo/LCM/Lightning checkpoints pin guidance → sampler `cfg` is inert.
 *  - the worker reads the Load Image (img2img) `strength`, never the sampler's own
 *    `denoise`, so a sampler `denoise` axis is ALWAYS inert.
 *  - a `loraRack.weight` / `controlNetRack.strength` axis fans out to the rack's
 *    ENABLED slots, so with ZERO enabled slots there is nothing to drive and the
 *    axis is inert. `enabledSlots` carries those counts (computed from the live
 *    workflow); an absent/unknown count is NOT flagged (only an explicit 0 is).
 * Returns the DISTINCT inert param names (in first-seen x,y,z order). Pure.
 */
export function inertParamsForModel(
  preset: FieldPreset,
  modelId: string,
  enabledSlots?: { loraRack?: number; controlNetRack?: number },
): string[] {
  const isTurbo = /turbo|lcm|lightning/i.test(modelId || '');
  const inert: string[] = [];
  const flag = (name: string) => {
    if (!inert.includes(name)) inert.push(name);
  };
  for (const axis of [preset.axes.x, preset.axes.y, preset.axes.z]) {
    for (const b of axis.params) {
      if (isTurbo && b.node === 'sampler' && b.param === 'cfg') flag('cfg');
      if (b.node === 'sampler' && b.param === 'denoise') flag('denoise');
      if (b.node === 'loraRack' && b.param === 'weight' && enabledSlots?.loraRack === 0) flag('weight');
      if (b.node === 'controlNetRack' && b.param === 'strength' && enabledSlots?.controlNetRack === 0) flag('strength');
    }
  }
  return inert;
}

/** Deep-clone one axis bundle (so runtime edits never mutate a shared preset). */
export function cloneBundle(b: AxisBundle): AxisBundle {
  return { label: b.label, params: b.params.map((p) => ({ ...p })) };
}

/** Deep-clone a preset (builtins are cloned into the runtime list on seed). */
export function clonePreset(p: FieldPreset): FieldPreset {
  return {
    ...p,
    axes: { x: cloneBundle(p.axes.x), y: cloneBundle(p.axes.y), z: cloneBundle(p.axes.z) },
  };
}
