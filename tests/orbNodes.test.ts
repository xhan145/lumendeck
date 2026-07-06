import { describe, expect, it } from 'vitest';
import { CAPSULES } from '../src/core/capsules';
import {
  gradientStops,
  primaryWeight,
  rampColor,
  ringAngle,
  weightT,
} from '../src/components/graph/graph3d/orbWeight';
import { ORB_RADIUS, orbSurfacePoint, orbWorldCenter, worldFromCanvas, zFromNode } from '../src/components/graph/graph3d/projection';
import { resolveCssColor } from '../src/components/graph/graph3d/scene';
import { NODE_WIDTH } from '../src/components/graph/wires';
import { initialPaletteState, paletteReducer, type PaletteState } from '../src/components/graph/paletteState';
import { sanitizeAppSettings, type AppSettings } from '../src/state/appSettings';
import type { WorkflowNode } from '../src/core/types';

describe('primaryWeight per-kind extraction', () => {
  it('sampler maps to cfg on the spec range 0-30', () => {
    expect(primaryWeight('sampler', { cfg: 12 })).toEqual({ value: 12, min: 0, max: 30, label: 'Guidance (CFG)' });
  });

  it('falls back to the ParamDef default when the param is unset', () => {
    expect(primaryWeight('sampler', {})).toEqual({ value: 7, min: 0, max: 30, label: 'Guidance (CFG)' });
  });

  it('imageLoader maps to denoise strength (0-1)', () => {
    const pw = primaryWeight('imageLoader', { strength: 0.6 });
    expect(pw).toEqual({ value: 0.6, min: 0, max: 1, label: 'Denoise strength' });
  });

  it('loraRack averages ENABLED slot weights only (mixed enabled/disabled)', () => {
    const slots = [
      { assetId: 'a', weight: 1, enabled: true },
      { assetId: 'b', weight: 0.2, enabled: false }, // ignored
      { assetId: 'c', weight: 0.5, enabled: true },
    ];
    const pw = primaryWeight('loraRack', { slots });
    expect(pw).not.toBeNull();
    expect(pw!.value).toBeCloseTo(0.75, 10);
    expect(pw!.min).toBe(-1);
    expect(pw!.max).toBe(2);
  });

  it('loraRack with no enabled slots (or no slots) is weightless', () => {
    expect(primaryWeight('loraRack', { slots: [] })).toBeNull();
    expect(primaryWeight('loraRack', { slots: [{ assetId: 'a', weight: 1, enabled: false }] })).toBeNull();
    expect(primaryWeight('loraRack', {})).toBeNull();
  });

  it('controlNetRack averages ENABLED slot strengths (0-2)', () => {
    const slots = [
      { id: '1', type: 'canny', strength: 1.2, image: '', enabled: true },
      { id: '2', type: 'depth', strength: 0.4, image: '', enabled: true },
      { id: '3', type: 'pose', strength: 2, image: '', enabled: false }, // ignored
    ];
    const pw = primaryWeight('controlNetRack', { slots });
    expect(pw).not.toBeNull();
    expect(pw!.value).toBeCloseTo(0.8, 10);
    expect(pw!.min).toBe(0);
    expect(pw!.max).toBe(2);
  });

  it('strength-driven kinds use their own ParamDef ranges', () => {
    expect(primaryWeight('conditioningAverage', { strength: 0.5 })).toMatchObject({ value: 0.5, min: 0, max: 1 });
    expect(primaryWeight('latentNoise', { strength: 1.5 })).toMatchObject({ value: 1.5, min: 0, max: 2 });
    expect(primaryWeight('control', { strength: 1 })).toMatchObject({ value: 1, min: 0, max: 2 });
    expect(primaryWeight('video', { motionStrength: 0.7 })).toMatchObject({ value: 0.7, min: 0, max: 2 });
    expect(primaryWeight('hiresFix', { denoise: 0.35 })).toMatchObject({ value: 0.35, min: 0, max: 1 });
  });

  it('generic fallback picks the kind\'s first numeric ParamDef', () => {
    // maskBlur is not in the per-kind table; its first number param is radius 0-256
    expect(primaryWeight('maskBlur', { radius: 64 })).toEqual({ value: 64, min: 0, max: 256, label: 'Radius' });
    // sanity: that really is the first number param in the registry
    expect(CAPSULES.maskBlur.params.find((p) => p.kind === 'number')!.id).toBe('radius');
  });

  it('kinds with no numeric params are weightless (neutral orb)', () => {
    expect(primaryWeight('prompt', { positive: 'x', negative: 'y' })).toBeNull();
    expect(primaryWeight('vaeEncode', {})).toBeNull();
    expect(primaryWeight('note', { body: 'hello' })).toBeNull();
  });
});

describe('weightT normalization + clamping', () => {
  it('normalizes into 0..1', () => {
    expect(weightT('sampler', { cfg: 15 })).toBeCloseTo(0.5, 10);
    expect(weightT('maskBlur', { radius: 64 })).toBeCloseTo(0.25, 10);
    expect(weightT('loraRack', { slots: [{ assetId: 'a', weight: 0.5, enabled: true }] }))
      .toBeCloseTo((0.5 - -1) / 3, 10);
  });

  it('clamps below min to 0 and above max to 1', () => {
    expect(weightT('sampler', { cfg: -5 })).toBe(0);
    expect(weightT('sampler', { cfg: 99 })).toBe(1);
  });

  it('is null for weightless kinds', () => {
    expect(weightT('prompt', {})).toBeNull();
    expect(weightT('loraRack', { slots: [] })).toBeNull();
  });
});

describe('gradientStops brand ramp (cyan -> violet -> mango)', () => {
  it('t=0 reads cool: cyan body, violet crown', () => {
    expect(gradientStops(0)).toEqual(['#34d6f4', '#34d6f4', '#7c3aed']);
  });

  it('t=1 reads hot: violet base, mango body', () => {
    expect(gradientStops(1)).toEqual(['#7c3aed', '#ff8a3d', '#ff8a3d']);
  });

  it('t=0.5 centers on violet with the half-window blends around it', () => {
    // low = ramp(0.25) = mix(cyan, violet, 0.5); high = ramp(0.75) = mix(violet, mango, 0.5)
    expect(gradientStops(0.5)).toEqual(['#5888f1', '#7c3aed', '#be6295']);
  });

  it('mid stop is always the exact weight color ramp(t)', () => {
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      expect(gradientStops(t)[1]).toBe(rampColor(t));
    }
  });

  it('clamps out-of-range t and always emits #rrggbb hex', () => {
    expect(gradientStops(-1)).toEqual(gradientStops(0));
    expect(gradientStops(2)).toEqual(gradientStops(1));
    for (const stop of gradientStops(0.37)) {
      expect(stop).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('ringAngle (the slider made visible)', () => {
  it('sweeps t * 2π', () => {
    expect(ringAngle(0)).toBe(0);
    expect(ringAngle(0.25)).toBeCloseTo(Math.PI / 2, 12);
    expect(ringAngle(0.5)).toBeCloseTo(Math.PI, 12);
    expect(ringAngle(1)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('clamps t to 0..1', () => {
    expect(ringAngle(-0.5)).toBe(0);
    expect(ringAngle(1.5)).toBeCloseTo(2 * Math.PI, 12);
  });
});

describe('orb wire endpoint math', () => {
  it('orbSurfacePoint lies at exactly radius from center, toward the target', () => {
    const p = orbSurfacePoint({ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }, ORB_RADIUS);
    expect(p.x).toBeCloseTo(ORB_RADIUS, 10);
    expect(p.y).toBeCloseTo(0, 10);
    expect(p.z).toBeCloseTo(0, 10);

    const c = { x: 10, y: -20, z: 30 };
    const towards = { x: 10 + 3, y: -20 + 4, z: 30 + 12 }; // direction (3,4,12), length 13
    const q = orbSurfacePoint(c, towards, 55);
    expect(Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z)).toBeCloseTo(55, 10);
    expect(q.x - c.x).toBeCloseTo((3 / 13) * 55, 10);
    expect(q.y - c.y).toBeCloseTo((4 / 13) * 55, 10);
    expect(q.z - c.z).toBeCloseTo((12 / 13) * 55, 10);
  });

  it('degenerate towards == center returns the center', () => {
    const c = { x: 5, y: 6, z: 7 };
    expect(orbSurfacePoint(c, { ...c }, 55)).toEqual(c);
  });

  it('orbWorldCenter sits centered on the card footprint, one radius down, on the node plane', () => {
    const node: WorkflowNode = { id: 'n1', kind: 'sampler', x: 300, y: 150, params: {} };
    const expected = worldFromCanvas({ x: 300 + NODE_WIDTH / 2, y: 150 + ORB_RADIUS }, zFromNode(300));
    expect(orbWorldCenter(node)).toEqual(expected);
  });
});

describe('resolveCssColor (guard: THREE.Color must never see a var() string)', () => {
  // No getComputedStyle in the node test env — matched tokens fall back to a
  // concrete slate instead of resolving, which is exactly what we assert on.
  const el = {} as unknown as Element;

  it('matches underscore token names (--sock-lora_stack regression)', () => {
    for (const input of ['var(--sock-lora_stack)', 'var(--sock-upscale_model)', 'var(--sock-latent)']) {
      const out = resolveCssColor(input, el);
      expect(out.startsWith('var(')).toBe(false);
      expect(out).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('never passes an unresolvable var() through', () => {
    const out = resolveCssColor('var(--bad token!)', el);
    expect(out.startsWith('var(')).toBe(false);
    expect(out).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('passes concrete colors through untouched', () => {
    expect(resolveCssColor('#34d6f4', el)).toBe('#34d6f4');
    expect(resolveCssColor('  rgb(1, 2, 3) ', el)).toBe('rgb(1, 2, 3)');
  });
});

describe('paletteReducer (collapsible palette state machine)', () => {
  const closed = (): PaletteState => initialPaletteState(false);

  it('starts collapsed at rest, open when pinned', () => {
    expect(initialPaletteState(false).open).toBe(false);
    expect(initialPaletteState(true).open).toBe(true);
  });

  it('pointer-enter expands; pointer-leave alone does NOT collapse (delay-based)', () => {
    let s = paletteReducer(closed(), { type: 'pointer-enter' });
    expect(s.open).toBe(true);
    s = paletteReducer(s, { type: 'pointer-leave' });
    expect(s.open).toBe(true); // still open until the timeout fires
  });

  it('collapse-timeout collapses once pointer AND focus are both outside', () => {
    let s = paletteReducer(closed(), { type: 'pointer-enter' });
    s = paletteReducer(s, { type: 'pointer-leave' });
    s = paletteReducer(s, { type: 'collapse-timeout' });
    expect(s.open).toBe(false);
  });

  it('collapse-timeout is a no-op while focus is inside', () => {
    let s = paletteReducer(closed(), { type: 'focus-in' });
    s = paletteReducer(s, { type: 'collapse-timeout' });
    expect(s.open).toBe(true);
    s = paletteReducer(s, { type: 'focus-out' });
    s = paletteReducer(s, { type: 'collapse-timeout' });
    expect(s.open).toBe(false);
  });

  it('pinned palettes never auto-collapse and ignore Escape', () => {
    let s = paletteReducer(closed(), { type: 'set-pinned', pinned: true });
    expect(s.open).toBe(true);
    s = paletteReducer(s, { type: 'collapse-timeout' });
    expect(s.open).toBe(true);
    s = paletteReducer(s, { type: 'escape' });
    expect(s.open).toBe(true);
  });

  it('escape collapses immediately and clears focus-inside', () => {
    let s = paletteReducer(closed(), { type: 'focus-in' });
    s = paletteReducer(s, { type: 'escape' });
    expect(s.open).toBe(false);
    expect(s.focusInside).toBe(false);
  });

  it('unpinning keeps the palette open until the next collapse-timeout', () => {
    let s = paletteReducer(closed(), { type: 'set-pinned', pinned: true });
    s = paletteReducer(s, { type: 'set-pinned', pinned: false });
    expect(s.open).toBe(true);
    s = paletteReducer(s, { type: 'collapse-timeout' });
    expect(s.open).toBe(false);
  });

  it('returns the SAME state object for no-op events (React render bail-out)', () => {
    const rest = closed();
    expect(paletteReducer(rest, { type: 'pointer-leave' })).toBe(rest);
    expect(paletteReducer(rest, { type: 'focus-out' })).toBe(rest);
    expect(paletteReducer(rest, { type: 'collapse-timeout' })).toBe(rest);
    expect(paletteReducer(rest, { type: 'escape' })).toBe(rest);
    expect(paletteReducer(rest, { type: 'set-pinned', pinned: false })).toBe(rest);
    const pinned = initialPaletteState(true);
    expect(paletteReducer(pinned, { type: 'set-pinned', pinned: true })).toBe(pinned);
    expect(paletteReducer(pinned, { type: 'collapse-timeout' })).toBe(pinned);
  });
});

describe('appSettings palettePinned + graph3dStyle (additive)', () => {
  it('old persisted blobs load with both unset', () => {
    expect(sanitizeAppSettings({}).palettePinned).toBeUndefined();
    expect(sanitizeAppSettings({}).graph3dStyle).toBeUndefined();
    expect(sanitizeAppSettings(undefined).palettePinned).toBeUndefined();
    expect(sanitizeAppSettings(undefined).graph3dStyle).toBeUndefined();
  });

  it('accepts only booleans for palettePinned', () => {
    expect(sanitizeAppSettings({ palettePinned: true }).palettePinned).toBe(true);
    expect(sanitizeAppSettings({ palettePinned: false }).palettePinned).toBe(false);
    expect(sanitizeAppSettings({ palettePinned: 'yes' } as unknown as Partial<AppSettings>).palettePinned).toBeUndefined();
  });

  it('accepts only orbs/cards for graph3dStyle', () => {
    expect(sanitizeAppSettings({ graph3dStyle: 'orbs' }).graph3dStyle).toBe('orbs');
    expect(sanitizeAppSettings({ graph3dStyle: 'cards' }).graph3dStyle).toBe('cards');
    expect(sanitizeAppSettings({ graph3dStyle: 'weird' } as unknown as Partial<AppSettings>).graph3dStyle).toBeUndefined();
  });
});
