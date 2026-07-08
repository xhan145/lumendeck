import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_FIELD_PRESETS,
  applyPresetAxes,
  fieldProfileFromPreset,
  inertParamsForModel,
  presetAxesUsed,
  type AxisBundle,
  type FieldPreset,
} from '../src/core/field/presets';
import { buildPreviewJob } from '../src/core/field/preview';
import { fanOutRackPatches } from '../src/core/field/rackFanout';
import { applyPresetField } from '../src/core/field/applyField';
import { defaultFieldState, hydrateField, type PersistedFieldState } from '../src/state/field';
import { persistedProjection } from '../src/state/persistence';
import { addNode, createDefaultWorkflow, createNode, findNode, updateNodeParam } from '../src/core/workflow';
import type { ControlSlot, LoraSlot } from '../src/core/types';
import { useStudio, mockAdapter } from '../src/state/store';

const byId = (id: string): FieldPreset => BUILTIN_FIELD_PRESETS.find((p) => p.id === id)!;
const patch = (patches: { node: string; param: string; value: number }[], param: string) =>
  patches.find((p) => p.param === param)!;

/**
 * The WHITELIST of `node:param` bundles the render pipeline actually consumes
 * (buildRenderJob reads exactly these; the racks are consumed PER-SLOT via the
 * fan-out). Any preset axis param outside this set is a phantom/inert "dead axis"
 * — the recurring bug this suite guards against.
 */
const CONSUMED_PARAMS = new Set([
  'sampler:cfg',
  'sampler:steps',
  'sampler:seed',
  'sampler:denoise',
  'imageLoader:strength',
  'hiresFix:scale',
  'hiresFix:denoise',
  'hiresFix:steps',
  'loraRack:weight',
  'controlNetRack:strength',
]);

// ---------------------------------------------------------------------------
// presetAxesUsed — the HEADLINE guarantee: every builtin binds x AND y AND z
// ---------------------------------------------------------------------------
describe('BUILTIN_FIELD_PRESETS — every preset uses all three axes', () => {
  it('ships exactly 10 presets, each flagged builtin with a stable id', () => {
    expect(BUILTIN_FIELD_PRESETS).toHaveLength(10);
    const ids = BUILTIN_FIELD_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(10); // all ids unique
    for (const p of BUILTIN_FIELD_PRESETS) {
      expect(p.builtin).toBe(true);
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it('ALL 10 builtins pass presetAxesUsed (x + y + z each non-empty)', () => {
    for (const p of BUILTIN_FIELD_PRESETS) {
      expect(presetAxesUsed(p)).toBe(true);
      expect(p.axes.x.params.length).toBeGreaterThan(0);
      expect(p.axes.y.params.length).toBeGreaterThan(0);
      expect(p.axes.z.params.length).toBeGreaterThan(0);
    }
  });

  it('HEADLINE: every axis param of all 10 builtins is render-CONSUMED (whitelist — no dead axes)', () => {
    for (const p of BUILTIN_FIELD_PRESETS) {
      for (const [axisName, axis] of [['x', p.axes.x], ['y', p.axes.y], ['z', p.axes.z]] as const) {
        for (const b of axis.params) {
          const key = `${b.node}:${b.param}`;
          // Named assert so a phantom param points at the offending preset+axis.
          expect(CONSUMED_PARAMS.has(key), `${p.id} ${axisName}-axis binds non-consumed "${key}"`).toBe(true);
        }
      }
    }
  });

  it('NO builtin drives the Video node (video params are inert on a still preview)', () => {
    for (const p of BUILTIN_FIELD_PRESETS) {
      for (const axis of [p.axes.x, p.axes.y, p.axes.z]) {
        for (const b of axis.params) expect(b.node).not.toBe('video');
      }
    }
  });

  it('replaces builtin-motion with builtin-style-structure (all-XYZ, all-consumed)', () => {
    expect(BUILTIN_FIELD_PRESETS.some((p) => p.id === 'builtin-motion')).toBe(false);
    const ss = BUILTIN_FIELD_PRESETS.find((p) => p.id === 'builtin-style-structure');
    expect(ss).toBeDefined();
    expect(presetAxesUsed(ss!)).toBe(true);
    for (const axis of [ss!.axes.x, ss!.axes.y, ss!.axes.z]) {
      for (const b of axis.params) expect(CONSUMED_PARAMS.has(`${b.node}:${b.param}`)).toBe(true);
    }
  });

  it('every axis param names a real node kind + carries a usable numeric range', () => {
    const kinds = new Set(['sampler', 'imageLoader', 'hiresFix', 'controlNetRack', 'loraRack', 'video']);
    for (const p of BUILTIN_FIELD_PRESETS) {
      for (const axis of [p.axes.x, p.axes.y, p.axes.z]) {
        expect(axis.label.length).toBeGreaterThan(0);
        for (const b of axis.params) {
          expect(kinds.has(b.node)).toBe(true);
          expect(b.param.length).toBeGreaterThan(0);
          expect(Number.isFinite(b.min)).toBe(true);
          expect(Number.isFinite(b.max)).toBe(true);
          expect(b.max).toBeGreaterThan(b.min);
        }
      }
    }
  });

  it('returns false when ANY axis binds no parameter', () => {
    const bundle = (label: string): AxisBundle => ({ label, params: [{ node: 'sampler', param: 'cfg', min: 1, max: 10 }] });
    expect(presetAxesUsed({ axes: { x: bundle('X'), y: bundle('Y'), z: { label: 'Z', params: [] } } })).toBe(false);
    expect(presetAxesUsed({ axes: { x: { label: 'X', params: [] }, y: bundle('Y'), z: bundle('Z') } })).toBe(false);
    expect(presetAxesUsed({ axes: { x: bundle('X'), y: bundle('Y'), z: bundle('Z') } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyPresetAxes — maps all three axes onto their bundle params, with clamping
// ---------------------------------------------------------------------------
describe('applyPresetAxes', () => {
  const cfgExplorer = byId('builtin-cfg-explorer'); // X cfg 1..20, Y steps 8..60, Z seed 0..1000

  it('maps EACH axis to its range end at pos 0 and pos 1 (intensity 1)', () => {
    const atMax = applyPresetAxes(cfgExplorer, { x: 1, y: 1, z: 1 }, 1);
    expect(patch(atMax, 'cfg').value).toBeCloseTo(20, 9);
    expect(patch(atMax, 'steps').value).toBeCloseTo(60, 9);
    expect(patch(atMax, 'seed').value).toBeCloseTo(1000, 9);

    const atMin = applyPresetAxes(cfgExplorer, { x: 0, y: 0, z: 0 }, 1);
    expect(patch(atMin, 'cfg').value).toBeCloseTo(1, 9);
    expect(patch(atMin, 'steps').value).toBeCloseTo(8, 9);
    expect(patch(atMin, 'seed').value).toBeCloseTo(0, 9);
  });

  it('intensity 0 pins every param at its bundle midpoint regardless of position', () => {
    const mid = applyPresetAxes(cfgExplorer, { x: 1, y: 0, z: 1 }, 0);
    expect(patch(mid, 'cfg').value).toBeCloseTo((1 + 20) / 2, 9);
    expect(patch(mid, 'steps').value).toBeCloseTo((8 + 60) / 2, 9);
    expect(patch(mid, 'seed').value).toBeCloseTo(500, 9);
  });

  it('sweeps a MULTI-param bundle together (Classic Sampler X drives cfg AND steps)', () => {
    const classic = byId('builtin-classic-sampler'); // X = cfg 3..18 + steps 12..48
    const p = applyPresetAxes(classic, { x: 1, y: 0.5, z: 0 }, 1);
    expect(patch(p, 'cfg').value).toBeCloseTo(18, 9);
    expect(patch(p, 'steps').value).toBeCloseTo(48, 9);
  });

  it('clamps out-of-[0,1] coords to the bundle bounds and stamps the node kind', () => {
    const over = applyPresetAxes(cfgExplorer, { x: 9, y: -4, z: 42 }, 1);
    expect(patch(over, 'cfg').value).toBe(20); // clamped to max
    expect(patch(over, 'steps').value).toBe(8); // clamped to min
    for (const b of over) expect(b.node).toBe('sampler');
  });
});

// ---------------------------------------------------------------------------
// fieldProfileFromPreset / applyPresetField — feed the v0.16 applyField path
// ---------------------------------------------------------------------------
describe('fieldProfileFromPreset', () => {
  it('kind-filters axes so a single-node ghost gets only the params it owns', () => {
    const morph = byId('builtin-img2img-morph'); // X imageLoader.strength, Y sampler.cfg, Z sampler.seed
    const forSampler = fieldProfileFromPreset(morph, 'sampler');
    expect(forSampler.x).toBeUndefined(); // strength is imageLoader — dropped for the sampler
    expect(forSampler.y?.bundle.map((b) => b.param)).toEqual(['cfg']);
    expect(forSampler.z?.bundle.map((b) => b.param)).toEqual(['seed']);

    const forImage = fieldProfileFromPreset(morph, 'imageLoader');
    expect(forImage.x?.bundle.map((b) => b.param)).toEqual(['strength']);
    expect(forImage.y).toBeUndefined();
    expect(forImage.z).toBeUndefined();
  });

  it('with no kind, flattens every axis bundle (label + min/max preserved)', () => {
    const classic = byId('builtin-classic-sampler');
    const profile = fieldProfileFromPreset(classic);
    expect(profile.x?.label).toBe('Structure');
    expect(profile.x?.bundle.map((b) => b.param)).toEqual(['cfg', 'steps']);
    expect(profile.y?.bundle).toEqual([{ param: 'denoise', min: 0, max: 1 }]);
    expect(profile.z?.bundle.map((b) => b.param)).toEqual(['seed']);
  });

  it('applyPresetField drives a node via the same applyField math', () => {
    const classic = byId('builtin-classic-sampler');
    const patches = applyPresetField({ x: 1, y: 1, z: 1 }, 1, classic, 'n1', 'sampler');
    expect(patches.find((p) => p.param === 'cfg')!.value).toBeCloseTo(18, 9);
    for (const p of patches) expect(p.nodeId).toBe('n1');
  });
});

// ---------------------------------------------------------------------------
// inertParamsForModel — turbo pins cfg; sampler denoise is always inert
// ---------------------------------------------------------------------------
describe('inertParamsForModel', () => {
  it('flags sampler cfg as inert for turbo/LCM/Lightning models', () => {
    const cfgExplorer = byId('builtin-cfg-explorer');
    expect(inertParamsForModel(cfgExplorer, 'sd-turbo')).toContain('cfg');
    expect(inertParamsForModel(cfgExplorer, 'dreamshaper-lcm')).toContain('cfg');
    expect(inertParamsForModel(cfgExplorer, 'sdxl-lightning-4step')).toContain('cfg');
    // A normal model does NOT pin guidance.
    expect(inertParamsForModel(cfgExplorer, 'sd15-photoreal')).not.toContain('cfg');
  });

  it('ALWAYS flags a sampler denoise axis (the worker reads img2img strength)', () => {
    const classic = byId('builtin-classic-sampler'); // Y = sampler.denoise
    expect(inertParamsForModel(classic, 'sd15-photoreal')).toContain('denoise');
    expect(inertParamsForModel(classic, 'sd-turbo')).toContain('denoise');
  });

  it('does NOT flag a hiresFix denoise axis (only the sampler denoise is dead)', () => {
    const detail = byId('builtin-detail-upscale'); // Y = hiresFix.denoise (real)
    expect(inertParamsForModel(detail, 'sd15-photoreal')).not.toContain('denoise');
  });

  it('returns distinct param names only', () => {
    const classic = byId('builtin-classic-sampler');
    const inert = inertParamsForModel(classic, 'sd-turbo'); // cfg (turbo) + denoise (always)
    expect(inert).toEqual([...new Set(inert)]);
    expect(inert).toEqual(expect.arrayContaining(['cfg', 'denoise']));
  });

  it('flags a loraRack.weight axis inert only when ZERO LoRA slots are enabled', () => {
    const styleStructure = byId('builtin-style-structure'); // X = loraRack.weight
    expect(inertParamsForModel(styleStructure, 'sd15-photoreal', { loraRack: 0 })).toContain('weight');
    expect(inertParamsForModel(styleStructure, 'sd15-photoreal', { loraRack: 2 })).not.toContain('weight');
    // An unknown/absent count is NOT flagged (backward-compatible — only explicit 0).
    expect(inertParamsForModel(styleStructure, 'sd15-photoreal')).not.toContain('weight');
  });

  it('flags a controlNetRack.strength axis inert only when ZERO control slots are enabled', () => {
    const cnBalance = byId('builtin-controlnet-balance'); // X = controlNetRack.strength
    expect(inertParamsForModel(cnBalance, 'sd15-photoreal', { controlNetRack: 0 })).toContain('strength');
    expect(inertParamsForModel(cnBalance, 'sd15-photoreal', { controlNetRack: 3 })).not.toContain('strength');
    expect(inertParamsForModel(cnBalance, 'sd15-photoreal')).not.toContain('strength');
  });
});

// ---------------------------------------------------------------------------
// buildPreviewJob — fast low-res variant of the field-resolved params
// ---------------------------------------------------------------------------
describe('buildPreviewJob', () => {
  it('overrides width/height + steps and forces an image output', () => {
    const wf = createDefaultWorkflow();
    const patches = applyPresetAxes(byId('builtin-classic-sampler'), { x: 1, y: 1, z: 1 }, 1);
    const job = buildPreviewJob(wf, patches, { size: 256, steps: 6 });
    expect(job.width).toBe(256);
    expect(job.height).toBe(256);
    expect(job.steps).toBe(6);
    expect(job.output).toBe('image');
    // The field-resolved params flow through buildRenderJob: X cfg → 18, Y denoise → 1.
    expect(job.cfg).toBeCloseTo(18, 9);
    expect(job.denoise).toBeCloseTo(1, 9);
  });

  it('defaults to 320px / 4 steps when no options are given', () => {
    const wf = createDefaultWorkflow();
    const job = buildPreviewJob(wf, applyPresetAxes(byId('builtin-cfg-explorer'), { x: 0.5, y: 0.5, z: 0.5 }, 1));
    expect(job.width).toBe(320);
    expect(job.height).toBe(320);
    expect(job.steps).toBe(4);
  });

  it('skips patches for node kinds absent from the graph (no throw, no pollution)', () => {
    const wf = createDefaultWorkflow(); // has NO imageLoader
    const patches = applyPresetAxes(byId('builtin-img2img-morph'), { x: 1, y: 1, z: 1 }, 1);
    const job = buildPreviewJob(wf, patches, { size: 128, steps: 2 });
    // imageLoader.strength patch is skipped; the default img2img strength survives.
    expect(job.denoiseStrength).toBeCloseTo(0.6, 9);
    // The sampler cfg patch (Y = 2..14) still lands.
    expect(job.cfg).toBeCloseTo(14, 9);
  });
});

// ---------------------------------------------------------------------------
// fanOutRackPatches — push an aggregate weight/strength into a rack's ENABLED
// slots (the fix for the LoRA/ControlNet "dead axis"); no-op on zero slots.
// ---------------------------------------------------------------------------
describe('fanOutRackPatches', () => {
  const loraWorkflow = (slots: LoraSlot[]) => {
    const wf = createDefaultWorkflow(); // has a loraRack node (slots default [])
    const rack = findNode(wf, 'loraRack')!;
    return updateNodeParam(wf, rack.id, 'slots', slots);
  };
  const cnWorkflow = (slots: ControlSlot[]) => {
    const wf = addNode(createDefaultWorkflow(), createNode('controlNetRack', 0, 0));
    const rack = findNode(wf, 'controlNetRack')!;
    return updateNodeParam(wf, rack.id, 'slots', slots);
  };

  it('sets EVERY enabled loraRack slot weight and leaves disabled slots untouched', () => {
    const wf = loraWorkflow([
      { assetId: 'a', weight: 0.1, enabled: true },
      { assetId: 'b', weight: 0.2, enabled: false },
      { assetId: 'c', weight: 0.3, enabled: true },
    ]);
    const out = fanOutRackPatches(wf, [{ node: 'loraRack', param: 'weight', value: 1.5 }]);
    const slots = findNode(out, 'loraRack')!.params.slots as LoraSlot[];
    expect(slots.map((s) => s.weight)).toEqual([1.5, 0.2, 1.5]); // enabled → 1.5, disabled kept
  });

  it('sets EVERY enabled controlNetRack slot strength likewise', () => {
    const wf = cnWorkflow([
      { id: 's1', type: 'canny', strength: 0.5, image: '', enabled: true },
      { id: 's2', type: 'depth', strength: 0.6, image: '', enabled: false },
    ]);
    const out = fanOutRackPatches(wf, [{ node: 'controlNetRack', param: 'strength', value: 1.2 }]);
    const slots = findNode(out, 'controlNetRack')!.params.slots as ControlSlot[];
    expect(slots.map((s) => s.strength)).toEqual([1.2, 0.6]);
  });

  it('is a NO-OP (same reference) when the rack has zero enabled slots', () => {
    const allDisabled = loraWorkflow([{ assetId: 'a', weight: 0.1, enabled: false }]);
    expect(fanOutRackPatches(allDisabled, [{ node: 'loraRack', param: 'weight', value: 1.5 }])).toBe(allDisabled);
  });

  it('is a NO-OP when the rack has no slots at all (default empty) or is absent', () => {
    const wf = createDefaultWorkflow(); // loraRack slots default []
    expect(fanOutRackPatches(wf, [{ node: 'loraRack', param: 'weight', value: 1.5 }])).toBe(wf);
    // controlNetRack node is absent from the default graph → no-op.
    expect(fanOutRackPatches(wf, [{ node: 'controlNetRack', param: 'strength', value: 1.5 }])).toBe(wf);
  });

  it('ignores non-rack-aggregate patches entirely', () => {
    const wf = loraWorkflow([{ assetId: 'a', weight: 0.1, enabled: true }]);
    // sampler.cfg is not a rack aggregate — fan-out leaves the workflow untouched.
    expect(fanOutRackPatches(wf, [{ node: 'sampler', param: 'cfg', value: 12 }])).toBe(wf);
  });
});

// ---------------------------------------------------------------------------
// field slice — preset CRUD, builtin-hide, and persistence round-trip
// ---------------------------------------------------------------------------
describe('store — field preset CRUD + persistence', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
    useStudio.setState({ field: defaultFieldState() });
  });

  it('setActiveFieldPreset selects a preset and null clears back to the auto field', () => {
    useStudio.getState().setActiveFieldPreset('builtin-chaos');
    expect(useStudio.getState().field.activePresetId).toBe('builtin-chaos');
    useStudio.getState().setActiveFieldPreset(null);
    expect(useStudio.getState().field.activePresetId).toBeNull();
    // An unknown id is ignored (never strands the active pointer on a ghost).
    useStudio.getState().setActiveFieldPreset('does-not-exist');
    expect(useStudio.getState().field.activePresetId).toBeNull();
  });

  it('saveFieldPreset adds a custom preset (builtin:false) and returns its id', () => {
    const axes = {
      x: { label: 'A', params: [{ node: 'sampler' as const, param: 'cfg', min: 1, max: 9 }] },
      y: { label: 'B', params: [{ node: 'sampler' as const, param: 'steps', min: 10, max: 40 }] },
      z: { label: 'C', params: [{ node: 'sampler' as const, param: 'seed', min: 0, max: 500 }] },
    };
    const id = useStudio.getState().saveFieldPreset('My preset', axes);
    const saved = useStudio.getState().field.presets.find((p) => p.id === id)!;
    expect(saved.name).toBe('My preset');
    expect(saved.builtin).toBe(false);
    expect(useStudio.getState().field.presets).toHaveLength(11); // 10 builtins + 1 custom
    // Saved bundles are CLONED — mutating the input never mutates stored state.
    axes.x.params[0].min = 999;
    expect(saved.axes.x.params[0].min).toBe(1);
  });

  it('updateFieldPresetAxis replaces exactly one axis bundle', () => {
    const newBundle: AxisBundle = { label: 'Guidance!', params: [{ node: 'sampler', param: 'cfg', min: 4, max: 4 }] };
    useStudio.getState().updateFieldPresetAxis('builtin-classic-sampler', 'x', newBundle);
    const p = useStudio.getState().field.presets.find((x) => x.id === 'builtin-classic-sampler')!;
    expect(p.axes.x.label).toBe('Guidance!');
    expect(p.axes.x.params).toEqual([{ node: 'sampler', param: 'cfg', min: 4, max: 4 }]);
    expect(p.axes.y.params.map((b) => b.param)).toEqual(['denoise']); // untouched
  });

  it('deleteFieldPreset removes a preset and clears the active id if it pointed there', () => {
    useStudio.getState().setActiveFieldPreset('builtin-style-structure');
    useStudio.getState().deleteFieldPreset('builtin-style-structure');
    expect(useStudio.getState().field.presets.some((p) => p.id === 'builtin-style-structure')).toBe(false);
    expect(useStudio.getState().field.activePresetId).toBeNull();
  });

  it('persistence round-trips custom presets + active id, and keeps hidden builtins hidden', () => {
    const id = useStudio.getState().saveFieldPreset('Keeper', {
      x: { label: 'A', params: [{ node: 'sampler', param: 'cfg', min: 1, max: 9 }] },
      y: { label: 'B', params: [{ node: 'sampler', param: 'steps', min: 10, max: 40 }] },
      z: { label: 'C', params: [{ node: 'sampler', param: 'seed', min: 0, max: 500 }] },
    });
    useStudio.getState().setActiveFieldPreset(id);
    useStudio.getState().deleteFieldPreset('builtin-chaos'); // hide a builtin

    const projection = persistedProjection(useStudio.getState());
    const field = projection.field as PersistedFieldState;
    expect(field.activePresetId).toBe(id);
    expect(field.hiddenBuiltinIds).toContain('builtin-chaos');
    // previewImage/previewPending/streamingEnabled are NEVER persisted.
    expect(field).not.toHaveProperty('previewImage');
    expect(field).not.toHaveProperty('previewPending');
    expect(field).not.toHaveProperty('streamingEnabled');

    const restored = hydrateField(field);
    expect(restored.presets.some((p) => p.id === id)).toBe(true); // custom survives
    expect(restored.presets.some((p) => p.id === 'builtin-chaos')).toBe(false); // stays hidden
    expect(restored.presets.some((p) => p.id === 'builtin-classic-sampler')).toBe(true); // others re-seed
    expect(restored.activePresetId).toBe(id);
    expect(restored.previewImage).toBeNull();
    expect(restored.streamingEnabled).toBe(false);
  });

  it('an OLD blob with no preset fields hydrates with all 10 builtins seeded', () => {
    const old: PersistedFieldState = { ghosts: [], anchors: [] };
    const restored = hydrateField(old);
    expect(restored.presets).toHaveLength(10);
    expect(restored.activePresetId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// store — runFieldPreview (supersede token) + promoteFieldPreviewToRender
// ---------------------------------------------------------------------------
describe('store — streaming preview', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
    useStudio.setState({ field: defaultFieldState() });
    useStudio.getState().setAdapter('mock'); // deterministic; generate is spied below
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a preview for the active preset and stores the image (pending clears)', async () => {
    const spy = vi
      .spyOn(mockAdapter, 'generate')
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,PREVIEW', seed: 1, mediaType: 'image', mimeType: 'image/png', extension: 'png' });
    useStudio.getState().setActiveFieldPreset('builtin-classic-sampler');
    await useStudio.getState().runFieldPreview({ x: 1, y: 1, z: 1 });

    expect(useStudio.getState().field.previewImage).toBe('data:image/png;base64,PREVIEW');
    expect(useStudio.getState().field.previewPending).toBe(false);
    // The job handed to the backend is the fast low-res variant.
    const job = spy.mock.calls[0][0];
    expect(job.width).toBe(320);
    expect(job.height).toBe(320);
    expect(job.steps).toBe(4);
    expect(job.cfg).toBeCloseTo(18, 9);
  });

  it('with no active preset it is a loud no-op (never calls the backend)', async () => {
    const spy = vi.spyOn(mockAdapter, 'generate');
    useStudio.getState().setActiveFieldPreset(null);
    await useStudio.getState().runFieldPreview({ x: 0.5, y: 0.5, z: 0.5 });
    expect(spy).not.toHaveBeenCalled();
    expect(useStudio.getState().field.previewImage).toBeNull();
    expect(useStudio.getState().controlStatus).toMatch(/pick a field preset/i);
  });

  it('a newer position SUPERSEDES an older in-flight render (stale result discarded)', async () => {
    const resolvers: ((r: unknown) => void)[] = [];
    vi.spyOn(mockAdapter, 'generate').mockImplementation(
      () => new Promise((res) => { resolvers.push(res as (r: unknown) => void); }),
    );
    useStudio.getState().setActiveFieldPreset('builtin-cfg-explorer');

    const stale = useStudio.getState().runFieldPreview({ x: 0, y: 0, z: 0 }); // token 1
    const latest = useStudio.getState().runFieldPreview({ x: 1, y: 1, z: 1 }); // token 2 (wins)
    expect(resolvers).toHaveLength(2);

    // Resolve the LATEST first: it owns the token, so its image lands.
    resolvers[1]({ dataUrl: 'LATEST', seed: 1, mediaType: 'image', mimeType: 'image/png', extension: 'png' });
    await latest;
    expect(useStudio.getState().field.previewImage).toBe('LATEST');
    expect(useStudio.getState().field.previewPending).toBe(false);

    // Resolve the STALE one AFTER: it must NOT overwrite the newer image.
    resolvers[0]({ dataUrl: 'STALE', seed: 1, mediaType: 'image', mimeType: 'image/png', extension: 'png' });
    await stale;
    expect(useStudio.getState().field.previewImage).toBe('LATEST');
  });

  it('a backend failure clears pending and surfaces a loud status — never a fake image', async () => {
    vi.spyOn(mockAdapter, 'generate').mockRejectedValue(new Error('bridge offline'));
    useStudio.getState().setActiveFieldPreset('builtin-classic-sampler');
    await useStudio.getState().runFieldPreview({ x: 0.5, y: 0.5, z: 0.5 });
    expect(useStudio.getState().field.previewImage).toBeNull();
    expect(useStudio.getState().field.previewPending).toBe(false);
    expect(useStudio.getState().controlStatus).toMatch(/preview needs the bridge/i);
  });

  it('promoteFieldPreviewToRender renders the ACTIVE GHOST position, NOT the {0.5} midpoint', async () => {
    vi.spyOn(mockAdapter, 'generate').mockResolvedValue({ dataUrl: 'data:image/png;base64,FULL', seed: 1, mediaType: 'image', mimeType: 'image/png', extension: 'png' });
    // classic-sampler X = cfg 3..18 (+ steps); the streamed midpoint would be 10.5.
    useStudio.getState().setActiveFieldPreset('builtin-classic-sampler');
    const samplerId = findNode(useStudio.getState().workflow, 'sampler')!.id;
    useStudio.getState().spawnGhost(samplerId);
    const ghost = useStudio.getState().field.ghosts[0];
    // Fly the ghost to the max corner — pos.x = 1 ⇒ cfg 18 (never the 0.5 midpoint).
    useStudio.getState().moveGhost(ghost.id, { x: 1, y: 1, z: 1 });
    // Never touched runFieldPreview (streaming off), so the OLD code would have
    // promoted the {0.5} default midpoint (cfg 10.5) instead of the ghost's cfg 18.
    await useStudio.getState().promoteFieldPreviewToRender();

    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    expect(sampler.params.cfg).toBeCloseTo(18, 9); // ghost pos=1, NOT the midpoint
    expect(sampler.params.cfg as number).not.toBeCloseTo(10.5, 1); // the old midpoint bug
  });

  it('promoteFieldPreviewToRender with a preset but NO ghost is a loud no-op', async () => {
    const spy = vi.spyOn(mockAdapter, 'generate');
    useStudio.getState().setActiveFieldPreset('builtin-classic-sampler');
    // No ghost in the field — nothing to promote.
    expect(useStudio.getState().field.ghosts).toHaveLength(0);
    await useStudio.getState().promoteFieldPreviewToRender();
    expect(spy).not.toHaveBeenCalled();
    expect(useStudio.getState().controlStatus).toMatch(/move a ghost/i);
  });

  it('promoteFieldPreviewToRender with no active preset is a loud no-op', async () => {
    const spy = vi.spyOn(mockAdapter, 'generate');
    useStudio.getState().setActiveFieldPreset(null);
    await useStudio.getState().promoteFieldPreviewToRender();
    expect(spy).not.toHaveBeenCalled();
    expect(useStudio.getState().controlStatus).toMatch(/pick a field preset/i);
  });
});
