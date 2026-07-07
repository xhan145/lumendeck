import { beforeEach, describe, expect, it } from 'vitest';
import { EASING, sampleTrack, sampleClip, clipValueForOrb, trackKey } from '../src/core/motion/interpolate';
import { motionOffset } from '../src/core/motion/orbMotion';
import { isBindable, bindableParams, defaultTrackParam } from '../src/core/motion/binding';
import { planMotionRender, renderMotionClip } from '../src/core/motion/renderPlan';
import { buildDemoClip, seedDemoClip, DEMO_CLIP_ID } from '../src/core/motion/demoClip';
import { hydrateMotion, emptyMotionState, makeClip, defaultTransport } from '../src/state/motion';
import type { Keyframe, MotionClip, MotionTrack, OrbMotion } from '../src/core/motion/types';
import { createDefaultWorkflow, findNode } from '../src/core/workflow';
import { useStudio } from '../src/state/store';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/** Keyframe literal without the (now-required) stable id — the helper fills it. */
type KfLiteral = Omit<Keyframe, 'id'> & { id?: string };
const track = (kfs: KfLiteral[], over: Partial<MotionTrack> = {}): MotionTrack => ({
  id: 't1', nodeId: 'n1', param: 'cfg',
  keyframes: kfs.map((k, i) => ({ id: k.id ?? `k${i}`, ...k })),
  ...over,
});

const clip = (tracks: MotionTrack[], over: Partial<MotionClip> = {}): MotionClip => ({
  id: 'c1', name: 'C', duration: 3, fps: 24, loop: true, tracks, orbMotions: {}, ...over,
});

// ---------------------------------------------------------------------------
// EASING — all six, unit interval
// ---------------------------------------------------------------------------
describe('EASING functions', () => {
  const kinds = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smoothstep'] as const;

  it('all continuous easings map endpoints 0->0 and 1->1', () => {
    for (const k of kinds) {
      expect(EASING[k](0)).toBeCloseTo(0, 12);
      expect(EASING[k](1)).toBeCloseTo(1, 12);
    }
  });

  it('linear is the identity', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) expect(EASING.linear(x)).toBeCloseTo(x, 12);
  });

  it('each continuous easing is monotonic non-decreasing on [0,1]', () => {
    for (const k of kinds) {
      let prev = -Infinity;
      for (let i = 0; i <= 20; i++) {
        const y = EASING[k](i / 20);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
  });

  it('easeIn is below linear, easeOut is above linear at the midpoint', () => {
    expect(EASING.easeIn(0.5)).toBeLessThan(0.5);
    expect(EASING.easeOut(0.5)).toBeGreaterThan(0.5);
  });

  it('smoothstep and easeInOut cross 0.5 at x=0.5', () => {
    expect(EASING.smoothstep(0.5)).toBeCloseTo(0.5, 12);
    expect(EASING.easeInOut(0.5)).toBeCloseTo(0.5, 12);
  });

  it('step holds 0 until the very end, then snaps to 1', () => {
    expect(EASING.step(0)).toBe(0);
    expect(EASING.step(0.5)).toBe(0);
    expect(EASING.step(0.999)).toBe(0);
    expect(EASING.step(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sampleTrack
// ---------------------------------------------------------------------------
describe('sampleTrack', () => {
  it('empty track -> null (caller falls back to live param)', () => {
    expect(sampleTrack(track([]), 1)).toBeNull();
  });

  it('single keyframe -> that value everywhere', () => {
    const t = track([{ t: 1, value: 42 }]);
    expect(sampleTrack(t, 0)).toBe(42);
    expect(sampleTrack(t, 1)).toBe(42);
    expect(sampleTrack(t, 99)).toBe(42);
  });

  it('clamps before the first and after the last keyframe', () => {
    const t = track([{ t: 1, value: 10 }, { t: 3, value: 20 }]);
    expect(sampleTrack(t, 0)).toBe(10); // before first
    expect(sampleTrack(t, 1)).toBe(10);
    expect(sampleTrack(t, 3)).toBe(20);
    expect(sampleTrack(t, 5)).toBe(20); // after last
  });

  it('linear interpolation between two keyframes (default easing)', () => {
    const t = track([{ t: 0, value: 0 }, { t: 2, value: 10 }]);
    expect(sampleTrack(t, 1)).toBeCloseTo(5, 12);
    expect(sampleTrack(t, 0.5)).toBeCloseTo(2.5, 12);
  });

  it('applies the INCOMING (right) keyframe easing across the segment', () => {
    // segment [0,2]; incoming keyframe (t=2) has easeIn -> midpoint eased down.
    const t = track([{ t: 0, value: 0 }, { t: 2, value: 10, easing: 'easeIn' }]);
    // easeIn(0.5) = 0.25 -> value 2.5
    expect(sampleTrack(t, 1)).toBeCloseTo(2.5, 12);
  });

  it('step easing holds the left value until the segment end', () => {
    const t = track([{ t: 0, value: 4 }, { t: 2, value: 18, easing: 'step' }]);
    expect(sampleTrack(t, 0.5)).toBe(4);
    expect(sampleTrack(t, 1.99)).toBe(4);
    expect(sampleTrack(t, 2)).toBe(18);
  });

  it('samples correctly across three keyframes (4 -> 18 -> 7)', () => {
    const t = track([
      { t: 0, value: 4 },
      { t: 1.5, value: 18 },
      { t: 3, value: 7 },
    ]);
    expect(sampleTrack(t, 0)).toBe(4);
    expect(sampleTrack(t, 1.5)).toBe(18);
    expect(sampleTrack(t, 3)).toBe(7);
    expect(sampleTrack(t, 0.75)).toBeCloseTo(11, 12); // halfway 4->18
    expect(sampleTrack(t, 2.25)).toBeCloseTo(12.5, 12); // halfway 18->7
  });

  it('is order-independent (unsorted keyframes still sample right)', () => {
    const sorted = track([{ t: 0, value: 0 }, { t: 1, value: 5 }, { t: 2, value: 10 }]);
    const shuffled = track([{ t: 2, value: 10 }, { t: 0, value: 0 }, { t: 1, value: 5 }]);
    for (const x of [0, 0.5, 1, 1.5, 2]) {
      expect(sampleTrack(shuffled, x)).toBeCloseTo(sampleTrack(sorted, x)!, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// sampleClip + trackKey
// ---------------------------------------------------------------------------
describe('sampleClip', () => {
  it('returns a Map keyed by nodeId:param with sampled values', () => {
    const c = clip([
      track([{ t: 0, value: 4 }, { t: 3, value: 10 }], { id: 'a', nodeId: 'sampler', param: 'cfg' }),
      track([{ t: 0, value: 0 }, { t: 3, value: 30 }], { id: 'b', nodeId: 'sampler', param: 'steps' }),
    ]);
    const m = sampleClip(c, 1.5);
    expect(m.get(trackKey('sampler', 'cfg'))).toBeCloseTo(7, 12);
    expect(m.get(trackKey('sampler', 'steps'))).toBeCloseTo(15, 12);
    expect(m.size).toBe(2);
  });

  it('omits empty tracks (null) so callers fall back to live params', () => {
    const c = clip([
      track([], { id: 'a', nodeId: 'n', param: 'cfg' }),
      track([{ t: 0, value: 5 }], { id: 'b', nodeId: 'n', param: 'steps' }),
    ]);
    const m = sampleClip(c, 1);
    expect(m.has(trackKey('n', 'cfg'))).toBe(false);
    expect(m.get(trackKey('n', 'steps'))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// clipValueForOrb
// ---------------------------------------------------------------------------
describe('clipValueForOrb', () => {
  const node = { id: 'sampler' };

  it('prefers the bound track value at t over the live value', () => {
    const c = clip([track([{ t: 0, value: 4 }, { t: 2, value: 8 }], { nodeId: 'sampler', param: 'cfg' })]);
    expect(clipValueForOrb(c, node, 1, 99)).toBeCloseTo(6, 12);
  });

  it('falls back to the live value when the node has no track', () => {
    const c = clip([track([{ t: 0, value: 4 }], { nodeId: 'other', param: 'cfg' })]);
    expect(clipValueForOrb(c, node, 1, 12.5)).toBe(12.5);
  });

  it('falls back to the live value when the matching track is empty', () => {
    const c = clip([track([], { nodeId: 'sampler', param: 'cfg' })]);
    expect(clipValueForOrb(c, node, 1, 7)).toBe(7);
  });

  it('selects the track by param when specified', () => {
    const c = clip([
      track([{ t: 0, value: 4 }], { id: 'a', nodeId: 'sampler', param: 'cfg' }),
      track([{ t: 0, value: 20 }], { id: 'b', nodeId: 'sampler', param: 'steps' }),
    ]);
    expect(clipValueForOrb(c, node, 0, 0, 'steps')).toBe(20);
    expect(clipValueForOrb(c, node, 0, 0, 'cfg')).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// motionOffset — per style
// ---------------------------------------------------------------------------
describe('motionOffset', () => {
  const mk = (style: OrbMotion['style'], speed: number, amplitude: number): OrbMotion => ({ style, speed, amplitude });

  it('still -> zero offset, unit scale', () => {
    expect(motionOffset(mk('still', 3, 100), 1, 1.23)).toEqual({ dx: 0, dy: 0, dz: 0, scale: 1 });
  });

  it('orbit radius scales with valueT (XZ circle), no Y, unit scale', () => {
    // at t=0: angle 0 -> (cos0, sin0) = (1,0); radius = amp*valueT
    const off = motionOffset(mk('orbit', 1, 100), 0.5, 0);
    expect(off.dx).toBeCloseTo(50, 12); // 100 * 0.5 * cos(0)
    expect(off.dz).toBeCloseTo(0, 12); // sin(0)
    expect(off.dy).toBe(0);
    expect(off.scale).toBe(1);
    // valueT=0 -> no radius at all
    const zero = motionOffset(mk('orbit', 1, 100), 0, 5);
    expect(Math.hypot(zero.dx, zero.dz)).toBeCloseTo(0, 12);
  });

  it('orbit point lies on a circle of radius amp*valueT for any t', () => {
    const om = mk('orbit', 2, 80);
    for (const t of [0, 0.3, 1.1, 2.7]) {
      const off = motionOffset(om, 0.75, t);
      expect(Math.hypot(off.dx, off.dz)).toBeCloseTo(80 * 0.75, 10);
    }
  });

  it('bob is a sine on Y only', () => {
    const om = mk('bob', Math.PI, 10); // speed*t = PI at t=1 -> sin(PI)=0
    const at1 = motionOffset(om, 1, 1);
    expect(at1.dy).toBeCloseTo(0, 10);
    expect(at1.dx).toBe(0);
    expect(at1.dz).toBe(0);
    const atHalf = motionOffset(om, 1, 0.5); // sin(PI/2)=1 -> dy=10
    expect(atHalf.dy).toBeCloseTo(10, 10);
  });

  it('pulse changes only scale, kept within ~0.8..1.4', () => {
    const om = mk('pulse', 1, 3);
    for (const t of [0, 0.5, 1, 1.7, 3.3]) {
      const off = motionOffset(om, 1, t);
      expect(off.dx).toBe(0);
      expect(off.dy).toBe(0);
      expect(off.dz).toBe(0);
      expect(off.scale).toBeGreaterThanOrEqual(0.8);
      expect(off.scale).toBeLessThanOrEqual(1.4);
    }
  });

  it('drift wanders in XZ (no Y), unit scale', () => {
    const off = motionOffset(mk('drift', 1, 40), 1, 1.3);
    expect(off.dy).toBe(0);
    expect(off.scale).toBe(1);
    // some horizontal motion for a non-trivial t
    expect(Math.abs(off.dx) + Math.abs(off.dz)).toBeGreaterThan(0);
  });

  it('clamps valueT to 0..1 for value-scaled styles', () => {
    const over = motionOffset(mk('orbit', 1, 10), 5, 0); // valueT>1 clamps to 1
    expect(Math.hypot(over.dx, over.dz)).toBeCloseTo(10, 10);
    const under = motionOffset(mk('orbit', 1, 10), -3, 0); // valueT<0 clamps to 0
    expect(Math.hypot(under.dx, under.dz)).toBeCloseTo(0, 10);
  });

  it('is deterministic: same inputs -> same output', () => {
    const om = mk('drift', 1.3, 55);
    expect(motionOffset(om, 0.6, 2.2)).toEqual(motionOffset(om, 0.6, 2.2));
  });
});

// ---------------------------------------------------------------------------
// binding — isBindable / bindableParams / defaultTrackParam
// ---------------------------------------------------------------------------
describe('binding validation', () => {
  it('isBindable accepts numeric params, rejects others', () => {
    expect(isBindable('sampler', 'cfg')).toBe(true);
    expect(isBindable('sampler', 'steps')).toBe(true);
    expect(isBindable('sampler', 'denoise')).toBe(true);
    // non-number kinds
    expect(isBindable('sampler', 'seed')).toBe(false); // kind 'seed'
    expect(isBindable('sampler', 'sampler')).toBe(false); // select
    expect(isBindable('prompt', 'positive')).toBe(false); // textarea
    expect(isBindable('canvas', 'tile')).toBe(false); // toggle
  });

  it('isBindable rejects unknown params and unknown kinds', () => {
    expect(isBindable('sampler', 'nope')).toBe(false);
    expect(isBindable('notAKind' as never, 'cfg')).toBe(false);
  });

  it('bindableParams lists exactly the numeric param ids', () => {
    expect(bindableParams('sampler')).toEqual(['steps', 'cfg', 'denoise', 'cfgRescale']);
    expect(bindableParams('canvas')).toEqual(['width', 'height', 'batch']);
    // a kind with no numeric params
    expect(bindableParams('prompt')).toEqual([]);
    expect(bindableParams('vaeEncode')).toEqual([]);
  });

  it('defaultTrackParam prefers the primary-weight param when bindable', () => {
    // sampler primary weight is cfg (a bindable number)
    expect(defaultTrackParam('sampler', { cfg: 7 })).toBe('cfg');
    // imageLoader primary weight is strength
    expect(defaultTrackParam('imageLoader', { strength: 0.6 })).toBe('strength');
  });

  it('defaultTrackParam falls back to the first bindable param, or null', () => {
    // loraRack primary weight uses slot means (synthetic label) -> no direct match,
    // so it falls back to the first numeric param (there are none -> null).
    expect(defaultTrackParam('loraRack', { slots: [] })).toBeNull();
    // prompt has no numeric params
    expect(defaultTrackParam('prompt')).toBeNull();
    // canvas has no per-kind primary override; first bindable is width
    expect(defaultTrackParam('canvas')).toBe('width');
  });
});

// ---------------------------------------------------------------------------
// planMotionRender / renderMotionClip stub
// ---------------------------------------------------------------------------
describe('planMotionRender', () => {
  const c = clip(
    [track([{ t: 0, value: 4 }, { t: 1.5, value: 18 }, { t: 3, value: 7 }], { nodeId: 'sampler', param: 'cfg' })],
    { duration: 3 },
  );

  it('emits exactly `frames` frames', () => {
    expect(planMotionRender(c, { frames: 5 })).toHaveLength(5);
    expect(planMotionRender(c, { frames: 1 })).toHaveLength(1);
  });

  it('clamps frames to at least 1', () => {
    expect(planMotionRender(c, { frames: 0 })).toHaveLength(1);
    expect(planMotionRender(c, { frames: -4 })).toHaveLength(1);
  });

  it('samples at evenly-spaced times spanning [0, duration]', () => {
    const frames = planMotionRender(c, { frames: 4 });
    expect(frames.map((f) => f.frame)).toEqual([0, 1, 2, 3]);
    expect(frames.map((f) => f.t)).toEqual([0, 1, 2, 3]); // duration 3, 4 frames -> step 1
    expect(frames[0].t).toBe(0);
    expect(frames[frames.length - 1].t).toBe(3);
  });

  it('single frame samples at t=0', () => {
    expect(planMotionRender(c, { frames: 1 })[0].t).toBe(0);
  });

  it('patch values match sampleClip at each frame time', () => {
    const frames = planMotionRender(c, { frames: 3 }); // t = 0, 1.5, 3
    expect(frames[0].paramPatches).toEqual([{ nodeId: 'sampler', param: 'cfg', value: 4 }]);
    expect(frames[1].paramPatches).toEqual([{ nodeId: 'sampler', param: 'cfg', value: 18 }]);
    expect(frames[2].paramPatches).toEqual([{ nodeId: 'sampler', param: 'cfg', value: 7 }]);
  });

  it('omits patches for empty tracks', () => {
    const empty = clip([track([], { nodeId: 'n', param: 'cfg' })], { duration: 2 });
    const frames = planMotionRender(empty, { frames: 3 });
    expect(frames.every((f) => f.paramPatches.length === 0)).toBe(true);
  });

  it('is pure/deterministic', () => {
    expect(planMotionRender(c, { frames: 6 })).toEqual(planMotionRender(c, { frames: 6 }));
  });
});

describe('renderMotionClip (Phase-2 stub)', () => {
  it('throws NotImplemented: Phase 2 (never a fake render)', () => {
    expect(() => renderMotionClip(clip([]))).toThrow(/NotImplemented: Phase 2/);
  });
});

// ---------------------------------------------------------------------------
// demoClip
// ---------------------------------------------------------------------------
describe('buildDemoClip', () => {
  it('is a 3s loop with a cfg track 4 -> 18 -> 7 (easeInOut) on the sampler', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const demo = buildDemoClip(wf)!;
    expect(demo.duration).toBe(3);
    expect(demo.loop).toBe(true);
    expect(demo.tracks).toHaveLength(1);
    const t = demo.tracks[0];
    expect(t.nodeId).toBe(sampler.id);
    expect(t.param).toBe('cfg');
    expect(t.keyframes.map((k) => k.value)).toEqual([4, 18, 7]);
    expect(t.keyframes.every((k) => k.easing === 'easeInOut')).toBe(true);
    expect(t.keyframes.map((k) => k.t)).toEqual([0, 1.5, 3]);
  });

  it('gives the sampler an orbit OrbMotion (plus a couple more nodes)', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const demo = buildDemoClip(wf)!;
    expect(demo.orbMotions[sampler.id].style).toBe('orbit');
    expect(Object.keys(demo.orbMotions).length).toBeGreaterThanOrEqual(2);
  });

  it('resolves against the workflow (samples the real cfg sweep)', () => {
    const demo = buildDemoClip(createDefaultWorkflow())!;
    const values = sampleClip(demo, 1.5);
    expect([...values.values()][0]).toBe(18);
  });
});

describe('seedDemoClip (idempotent)', () => {
  it('seeds the demo into an empty state and makes it active', () => {
    const wf = createDefaultWorkflow();
    const seeded = seedDemoClip(emptyMotionState(), wf);
    expect(seeded.clips.map((c) => c.id)).toContain(DEMO_CLIP_ID);
    expect(seeded.activeClipId).toBe(DEMO_CLIP_ID);
  });

  it('is a no-op when the demo already exists (does not duplicate)', () => {
    const wf = createDefaultWorkflow();
    const once = seedDemoClip(emptyMotionState(), wf);
    const twice = seedDemoClip(once, wf);
    expect(twice.clips.filter((c) => c.id === DEMO_CLIP_ID)).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it('preserves an existing active clip when seeding alongside user clips', () => {
    const wf = createDefaultWorkflow();
    const withUser = { clips: [makeClip('mine')], activeClipId: 'x' };
    withUser.activeClipId = withUser.clips[0].id;
    const seeded = seedDemoClip(withUser, wf);
    expect(seeded.activeClipId).toBe(withUser.clips[0].id); // unchanged
    expect(seeded.clips.some((c) => c.id === DEMO_CLIP_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// persistence migration — hydrateMotion
// ---------------------------------------------------------------------------
describe('hydrateMotion (persist migration)', () => {
  it('missing slice -> empty state seeded with the demo clip', () => {
    const wf = createDefaultWorkflow();
    const state = hydrateMotion(undefined, wf);
    expect(state.clips.some((c) => c.id === DEMO_CLIP_ID)).toBe(true);
    expect(state.activeClipId).toBe(DEMO_CLIP_ID);
  });

  it('present slice -> loaded, and the demo is (re)seeded if absent', () => {
    const wf = createDefaultWorkflow();
    const persisted = { clips: [makeClip('kept')], activeClipId: null };
    const keptId = persisted.clips[0].id;
    const state = hydrateMotion(persisted, wf);
    expect(state.clips.some((c) => c.id === keptId)).toBe(true);
    expect(state.clips.some((c) => c.id === DEMO_CLIP_ID)).toBe(true); // re-seeded
  });

  it('present slice already containing the demo is passed through unchanged', () => {
    const wf = createDefaultWorkflow();
    const demo = buildDemoClip(wf)!;
    const persisted = { clips: [demo], activeClipId: demo.id };
    const state = hydrateMotion(persisted, wf);
    expect(state.clips).toHaveLength(1);
    expect(state.activeClipId).toBe(demo.id);
  });

  it('malformed slice (no clips array) falls back to empty + demo', () => {
    const wf = createDefaultWorkflow();
    const state = hydrateMotion({ clips: undefined as never, activeClipId: null }, wf);
    expect(state.clips.some((c) => c.id === DEMO_CLIP_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// store — motion actions + transport (contract shape)
// ---------------------------------------------------------------------------
describe('store motion slice', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
    // reset motion to a single fresh clip we control
    const c = makeClip('Test clip');
    useStudio.setState({ motion: { clips: [c], activeClipId: c.id }, transport: { ...useStudio.getState().transport, ...defaultTransport() } });
  });

  const active = () => {
    const m = useStudio.getState().motion;
    return m.clips.find((c) => c.id === m.activeClipId)!;
  };

  it('createClip appends and activates a new clip', () => {
    const before = useStudio.getState().motion.clips.length;
    useStudio.getState().createClip('Another');
    const m = useStudio.getState().motion;
    expect(m.clips).toHaveLength(before + 1);
    expect(m.clips.find((c) => c.id === m.activeClipId)!.name).toBe('Another');
  });

  it('deleteClip removes it and repoints the active clip', () => {
    const id = active().id;
    useStudio.getState().createClip('keeper');
    useStudio.getState().setActiveClip(id);
    useStudio.getState().deleteClip(id);
    const m = useStudio.getState().motion;
    expect(m.clips.some((c) => c.id === id)).toBe(false);
    expect(m.activeClipId).toBe(m.clips[0]?.id ?? null);
  });

  it('addTrack binds only a valid numeric param and refuses duplicates', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    expect(active().tracks).toHaveLength(1);
    // duplicate (same node+param) is a no-op
    useStudio.getState().addTrack(sampler.id, 'cfg');
    expect(active().tracks).toHaveLength(1);
    // non-numeric param rejected
    useStudio.getState().addTrack(sampler.id, 'seed');
    expect(active().tracks).toHaveLength(1);
  });

  it('addKeyframe inserts in time order and replaces same-time keyframes', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    const trackId = active().tracks[0].id;
    useStudio.getState().addKeyframe(trackId, 2, 18);
    useStudio.getState().addKeyframe(trackId, 0, 4);
    useStudio.getState().addKeyframe(trackId, 1, 9);
    expect(active().tracks[0].keyframes.map((k) => k.t)).toEqual([0, 1, 2]);
    // replace at t=1
    useStudio.getState().addKeyframe(trackId, 1, 12);
    const kfs = active().tracks[0].keyframes;
    expect(kfs).toHaveLength(3);
    expect(kfs.find((k) => k.t === 1)!.value).toBe(12);
  });

  it('updateKeyframe patches easing and re-sorts on a time edit; removeKeyframe drops it (by id)', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    const trackId = active().tracks[0].id;
    const aId = useStudio.getState().addKeyframe(trackId, 0, 4);
    const bId = useStudio.getState().addKeyframe(trackId, 1, 8);
    useStudio.getState().updateKeyframe(trackId, aId, { easing: 'step' });
    expect(active().tracks[0].keyframes.find((k) => k.id === aId)!.easing).toBe('step');
    // move keyframe A past B -> re-sorted; A keeps its identity + patched easing
    useStudio.getState().updateKeyframe(trackId, aId, { t: 2 });
    expect(active().tracks[0].keyframes.map((k) => k.t)).toEqual([1, 2]);
    const a = active().tracks[0].keyframes.find((k) => k.id === aId)!;
    expect(a.t).toBe(2);
    expect(a.value).toBe(4); // still A's value, not B's
    useStudio.getState().removeKeyframe(trackId, bId);
    const kfs = active().tracks[0].keyframes;
    expect(kfs).toHaveLength(1);
    expect(kfs[0].id).toBe(aId); // removed B, kept A
  });

  it('removeTrack drops the track from the clip', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    const trackId = active().tracks[0].id;
    useStudio.getState().removeTrack(trackId);
    expect(active().tracks).toHaveLength(0);
  });

  it('setClipDuration/Fps/Loop update the active clip with sane clamps', () => {
    const id = active().id;
    useStudio.getState().setClipDuration(id, -5);
    expect(active().duration).toBe(0);
    useStudio.getState().setClipFps(id, 0);
    expect(active().fps).toBe(1);
    useStudio.getState().setClipLoop(id, false);
    expect(active().loop).toBe(false);
  });

  it('setOrbMotion records a per-node motion on the active clip', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().setOrbMotion(sampler.id, { style: 'bob', speed: 2, amplitude: 20 });
    expect(active().orbMotions[sampler.id]).toEqual({ style: 'bob', speed: 2, amplitude: 20 });
  });

  it('bakeClipToWorkflow writes sampled values into the capsule params (one commit, undo-safe)', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    const trackId = active().tracks[0].id;
    useStudio.getState().addKeyframe(trackId, 0, 4);
    useStudio.getState().addKeyframe(trackId, 2, 20);
    const versionBefore = useStudio.getState().workflow.version;
    useStudio.getState().bakeClipToWorkflow(1); // halfway -> cfg 12
    const s = findNode(useStudio.getState().workflow, 'sampler')!;
    expect(s.params.cfg).toBeCloseTo(12, 10);
    // a single workflow commit (version bumps once per updateNodeParam; one track -> +1)
    expect(useStudio.getState().workflow.version).toBe(versionBefore + 1);
  });

  it('transport actions only mutate the ephemeral playhead (no workflow writes)', () => {
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    const trackId = active().tracks[0].id;
    useStudio.getState().addKeyframe(trackId, 0, 4);
    useStudio.getState().addKeyframe(trackId, 2, 20);
    const cfgBefore = findNode(useStudio.getState().workflow, 'sampler')!.params.cfg;

    const tr = useStudio.getState().transport;
    tr.play();
    expect(useStudio.getState().transport.playing).toBe(true);
    tr.seek(1.5);
    expect(useStudio.getState().transport.t).toBe(1.5);
    tr.setRate(2);
    expect(useStudio.getState().transport.playbackRate).toBe(2);
    tr.pause();
    expect(useStudio.getState().transport.playing).toBe(false);
    tr.stop();
    expect(useStudio.getState().transport.t).toBe(0);
    expect(useStudio.getState().transport.playing).toBe(false);

    // playback/seek never touched the workflow param
    expect(findNode(useStudio.getState().workflow, 'sampler')!.params.cfg).toBe(cfgBefore);
  });

  it('transport actions clamp t and rate to >= 0', () => {
    const tr = useStudio.getState().transport;
    tr.seek(-5);
    expect(useStudio.getState().transport.t).toBe(0);
    tr.setRate(-2);
    expect(useStudio.getState().transport.playbackRate).toBe(0);
  });
});
