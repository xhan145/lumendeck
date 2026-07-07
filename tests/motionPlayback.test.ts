import { describe, expect, it } from 'vitest';
import {
  advancePlayback,
  createPlaybackDriver,
  PLAYBACK_FALLBACK_MS,
  type PlaybackDriverHooks,
} from '../src/components/graph/graph3d/playbackClock';
import { hydrateMotion, makeClip } from '../src/state/motion';
import { persistedProjection } from '../src/state/persistence';
import { createDefaultWorkflow, findNode } from '../src/core/workflow';
import type { MotionState } from '../src/core/motion/types';
import { useStudio } from '../src/state/store';

// ---------------------------------------------------------------------------
// BUG 1 — wall-clock stepper: the playhead advances by REAL elapsed time, and
// keeps advancing even when rAF never fires (hidden/minimized/occluded window).
// ---------------------------------------------------------------------------
describe('advancePlayback (pure wall-clock stepper)', () => {
  it('advances by dt * rate (no rAF frame counting)', () => {
    // 0.5s elapsed at 1x on a 3s loop -> t = 0.5, regardless of how many frames fired.
    expect(advancePlayback({ t: 0, dt: 0.5, rate: 1, duration: 3, loop: true })).toEqual({ t: 0.5, ended: false });
    // 0.5s elapsed at 2x -> t = 1.0
    expect(advancePlayback({ t: 0, dt: 0.5, rate: 2, duration: 3, loop: true })).toEqual({ t: 1, ended: false });
  });

  it('accumulates across steps (a real clock, not a per-tick reset)', () => {
    let t = 0;
    for (let i = 0; i < 4; i++) t = advancePlayback({ t, dt: 0.25, rate: 1, duration: 3, loop: true }).t;
    expect(t).toBeCloseTo(1, 12);
  });

  it('a large dt (starved rAF, then one big timer tick) still advances proportionally', () => {
    // Window was occluded for ~2s; a single fallback tick with dt=2 must jump the
    // playhead to 2s, NOT stall at 0 (the BUG 1 failure mode).
    const r = advancePlayback({ t: 0, dt: 2, rate: 1, duration: 3, loop: true });
    expect(r.t).toBeCloseTo(2, 12);
    expect(r.ended).toBe(false);
  });

  it('looping clips wrap with modulo and never "end"', () => {
    expect(advancePlayback({ t: 2.5, dt: 1, rate: 1, duration: 3, loop: true })).toEqual({ t: 0.5, ended: false });
  });

  it('non-looping clips clamp to duration and report ended', () => {
    expect(advancePlayback({ t: 2.5, dt: 1, rate: 1, duration: 3, loop: false })).toEqual({ t: 3, ended: true });
  });

  it('rate<=0 freezes the playhead in place', () => {
    expect(advancePlayback({ t: 1.2, dt: 5, rate: 0, duration: 3, loop: true })).toEqual({ t: 1.2, ended: false });
  });

  it('guards a zero/negative duration (no divide-by-zero)', () => {
    expect(advancePlayback({ t: 0, dt: 1, rate: 1, duration: 0, loop: true })).toEqual({ t: 0, ended: false });
    expect(advancePlayback({ t: 0, dt: 1, rate: 1, duration: 0, loop: false })).toEqual({ t: 0, ended: true });
  });

  it('is pure/deterministic', () => {
    const input = { t: 0.7, dt: 0.3, rate: 1.5, duration: 4, loop: true };
    expect(advancePlayback(input)).toEqual(advancePlayback(input));
  });
});

// ---------------------------------------------------------------------------
// BUG 1 — the driver arms BOTH rAF and a timer fallback; the timer alone keeps
// the loop ticking when rAF is starved (the flushScheduler starvation pattern).
// ---------------------------------------------------------------------------
function fakeDriverHooks() {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const hooks: PlaybackDriverHooks = {
    requestFrame: (cb) => { const id = nextId++; frames.set(id, cb); return id; },
    cancelFrame: (id) => { frames.delete(id); },
    setTimer: (cb) => { const id = nextId++; timers.set(id, cb); return id; },
    clearTimer: (id) => { timers.delete(id); },
  };
  const fireFrame = () => { for (const [id, cb] of [...frames]) { frames.delete(id); cb(); } };
  const fireTimer = () => { for (const [id, cb] of [...timers]) { timers.delete(id); cb(); } };
  return { hooks, fireFrame, fireTimer, counts: () => ({ frames: frames.size, timers: timers.size }) };
}

describe('createPlaybackDriver (rAF + timer fallback)', () => {
  it('fallback is longer than a frame but ~30Hz-ish', () => {
    expect(PLAYBACK_FALLBACK_MS).toBeGreaterThan(16);
    expect(PLAYBACK_FALLBACK_MS).toBeLessThanOrEqual(40);
  });

  it('REGRESSION: keeps ticking when rAF NEVER fires (timer fallback only)', () => {
    const f = fakeDriverHooks();
    let ticks = 0;
    const d = createPlaybackDriver(() => { ticks += 1; }, f.hooks);
    // Simulate a frame-starved window: only the timer ever fires.
    f.fireTimer();
    f.fireTimer();
    f.fireTimer();
    expect(ticks).toBe(3); // the playhead would have advanced 3 steps with no rAF
    expect(d.running()).toBe(true);
    d.stop();
  });

  it('ticks via rAF when visible and cancels the sibling timer each step', () => {
    const f = fakeDriverHooks();
    let ticks = 0;
    const d = createPlaybackDriver(() => { ticks += 1; }, f.hooks);
    f.fireFrame();
    expect(ticks).toBe(1);
    // exactly one frame + one timer armed for the NEXT step (sibling was cancelled)
    expect(f.counts()).toEqual({ frames: 1, timers: 1 });
    d.stop();
    expect(f.counts()).toEqual({ frames: 0, timers: 0 }); // provably idle after stop
  });

  it('a false return stops the loop (self-cancel: clip deleted / ended)', () => {
    const f = fakeDriverHooks();
    let ticks = 0;
    const d = createPlaybackDriver(() => { ticks += 1; return false; }, f.hooks);
    f.fireFrame();
    expect(ticks).toBe(1);
    expect(d.running()).toBe(false);
    expect(f.counts()).toEqual({ frames: 0, timers: 0 }); // nothing re-armed
  });

  it('stop() disarms everything without another tick', () => {
    const f = fakeDriverHooks();
    let ticks = 0;
    const d = createPlaybackDriver(() => { ticks += 1; }, f.hooks);
    d.stop();
    f.fireFrame();
    f.fireTimer();
    expect(ticks).toBe(0);
    expect(f.counts()).toEqual({ frames: 0, timers: 0 });
  });
});

// ---------------------------------------------------------------------------
// BUG 2a — the persisted projection excludes the ephemeral transport entirely,
// so a transport-only change produces a byte-identical projection and the
// persistence subscription bails (never resetting the save debounce mid-play).
// ---------------------------------------------------------------------------
describe('persistedProjection ignores transport (BUG 2a)', () => {
  const base = () => {
    const s = useStudio.getState();
    return {
      workflow: s.workflow,
      rackPresets: s.rackPresets,
      backendSettings: s.backendSettings,
      appSettings: s.appSettings,
      promptTools: s.promptTools,
      motion: s.motion,
    };
  };

  it('omits the transport playhead from the projection', () => {
    const proj = persistedProjection(base());
    expect('transport' in (proj as unknown as Record<string, unknown>)).toBe(false);
  });

  it('a transport-only advance yields an unchanged projection JSON (save is not reset)', () => {
    useStudio.getState().transport.stop();
    const before = JSON.stringify(persistedProjection(base()));
    // Advance the playhead as the playback loop would (transport write only).
    useStudio.getState().transport.play();
    useStudio.getState().transport.seek(1.23);
    const after = JSON.stringify(persistedProjection(base()));
    expect(after).toBe(before); // identical -> subscription bails, debounce survives
    useStudio.getState().transport.stop();
  });

  it('an authored-clip change DOES change the projection JSON (a real save fires)', () => {
    const c = makeClip('persist me');
    useStudio.setState({ motion: { clips: [c], activeClipId: c.id } });
    const before = JSON.stringify(persistedProjection(base()));
    useStudio.getState().setClipLoop(c.id, !c.loop);
    const after = JSON.stringify(persistedProjection(base()));
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// BUG 3 — deleting the active clip while it is PLAYING must clear the transport
// so nothing is left "playing" a clip that no longer exists (no zombie loop).
// ---------------------------------------------------------------------------
describe('deleteClip clears transport when the active clip was playing (BUG 3)', () => {
  it('deleting the active, playing clip sets playing=false and t=0', () => {
    const c = makeClip('to delete');
    useStudio.setState({
      motion: { clips: [c], activeClipId: c.id },
      transport: { ...useStudio.getState().transport, playing: true, t: 1.4 },
    });
    useStudio.getState().deleteClip(c.id);
    const s = useStudio.getState();
    expect(s.motion.clips.some((x) => x.id === c.id)).toBe(false);
    expect(s.transport.playing).toBe(false);
    expect(s.transport.t).toBe(0);
  });

  it('deleting a NON-active clip leaves a running transport alone', () => {
    const a = makeClip('active');
    const b = makeClip('other');
    useStudio.setState({
      motion: { clips: [a, b], activeClipId: a.id },
      transport: { ...useStudio.getState().transport, playing: true, t: 0.9 },
    });
    useStudio.getState().deleteClip(b.id);
    const s = useStudio.getState();
    expect(s.transport.playing).toBe(true); // untouched
    expect(s.transport.t).toBe(0.9);
    expect(s.motion.activeClipId).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// BUG 4 — a keyframe dragged/nudged ACROSS a neighbor keeps its own identity
// (id), so the store never re-times the wrong keyframe after the re-sort.
// ---------------------------------------------------------------------------
describe('keyframe edits by id survive a re-sort crossing (BUG 4)', () => {
  it('nudging the earliest keyframe past the latest edits the SAME keyframe', () => {
    useStudio.getState().resetWorkflow();
    const c = makeClip('kf');
    useStudio.setState({ motion: { clips: [c], activeClipId: c.id } });
    const sampler = findNode(useStudio.getState().workflow, 'sampler')!;
    useStudio.getState().addTrack(sampler.id, 'cfg');
    const trackId = useStudio.getState().motion.clips[0].tracks[0].id;

    const lowId = useStudio.getState().addKeyframe(trackId, 0, 4);   // value 4 @ t0
    const midId = useStudio.getState().addKeyframe(trackId, 1, 10);  // value 10 @ t1
    const highId = useStudio.getState().addKeyframe(trackId, 2, 18); // value 18 @ t2

    // Drag `lowId` (value 4) all the way to t=3, crossing BOTH neighbors.
    useStudio.getState().updateKeyframe(trackId, lowId, { t: 3 });

    const kfs = () => useStudio.getState().motion.clips[0].tracks[0].keyframes;
    // Order is now mid, high, low — but ids are intact and values did not swap.
    expect(kfs().map((k) => k.id)).toEqual([midId, highId, lowId]);
    expect(kfs().find((k) => k.id === lowId)!.value).toBe(4);  // still the dragged one
    expect(kfs().find((k) => k.id === midId)!.value).toBe(10); // untouched
    expect(kfs().find((k) => k.id === highId)!.value).toBe(18); // untouched

    // Removing by id drops exactly the intended keyframe after the crossing.
    useStudio.getState().removeKeyframe(trackId, midId);
    expect(kfs().map((k) => k.id)).toEqual([highId, lowId]);
  });
});

// ---------------------------------------------------------------------------
// BUG 4 (migration) — a persisted clip whose keyframes predate the id field
// hydrates with ids assigned (additive; old blobs still load).
// ---------------------------------------------------------------------------
describe('hydrateMotion assigns ids to pre-id keyframes (BUG 4 migration)', () => {
  it('old keyframes (no id) get deterministic ids; values/times preserved', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    // A legacy clip whose keyframes have NO id (as older blobs do). Cast through
    // unknown because the persisted shape predates the required `id` field.
    const legacy = {
      clips: [
        {
          id: 'legacy_clip',
          name: 'Legacy',
          duration: 3,
          fps: 24,
          loop: true,
          tracks: [
            {
              id: 'legacy_track',
              nodeId: sampler.id,
              param: 'cfg',
              keyframes: [
                { t: 0, value: 4 },
                { t: 1.5, value: 18 },
              ],
            },
          ],
          orbMotions: {},
        },
      ],
      activeClipId: 'legacy_clip',
    } as unknown as MotionState;

    const state = hydrateMotion(legacy, wf);
    const loaded = state.clips.find((c) => c.id === 'legacy_clip')!;
    const kfs = loaded.tracks[0].keyframes;
    expect(kfs).toHaveLength(2);
    // Every keyframe now has a non-empty stable id.
    expect(kfs.every((k) => typeof k.id === 'string' && k.id.length > 0)).toBe(true);
    // Ids are deterministic (derived from track id + index).
    expect(kfs.map((k) => k.id)).toEqual(['legacy_track_k0', 'legacy_track_k1']);
    // Values/times are untouched by the migration.
    expect(kfs.map((k) => [k.t, k.value])).toEqual([[0, 4], [1.5, 18]]);
    // Idempotent: hydrating the already-migrated state does not change the ids.
    const again = hydrateMotion(state, wf);
    expect(again.clips.find((c) => c.id === 'legacy_clip')!.tracks[0].keyframes.map((k) => k.id))
      .toEqual(['legacy_track_k0', 'legacy_track_k1']);
  });
});
