/**
 * Pure interpolation core for the Motion Engine. No DOM, no three.js — every fn
 * here is deterministic and unit-testable (see tests/motion.test.ts).
 *
 * Time is in SECONDS. Value curves ("tracks") are sampled at the playhead; the
 * result feeds gradients/rings + orb motion. This is the tested heart of Phase 1.
 */
import type { EasingKind, Keyframe, MotionClip, MotionTrack } from './types';

/**
 * Unit-interval easing functions: each maps x in [0,1] -> [0,1] with f(0)=0 and
 * f(1)=1 (except `step`, which snaps at the segment end). Used to shape the
 * progress fraction WITHIN a keyframe segment before the linear value lerp.
 */
export const EASING: Record<EasingKind, (x: number) => number> = {
  linear: (x) => x,
  easeIn: (x) => x * x,
  easeOut: (x) => 1 - (1 - x) * (1 - x),
  easeInOut: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  smoothstep: (x) => x * x * (3 - 2 * x),
  // Hold the start value until the very end of the segment, then snap.
  step: (x) => (x >= 1 ? 1 : 0),
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The unique key a sampled param is stored under in a clip's value map. */
export function trackKey(nodeId: string, param: string): string {
  return `${nodeId}:${param}`;
}

/**
 * Sample a track at time `t` (seconds).
 * - empty track -> null (caller falls back to the live workflow param).
 * - single keyframe -> that keyframe's value.
 * - before the first / after the last keyframe -> clamp to that endpoint value.
 * - between two keyframes -> lerp shaped by the *incoming* (right) keyframe's
 *   easing across the segment.
 *
 * Keyframes are expected in ascending `t`; a defensive sort makes sampling
 * order-independent (authoring may insert out of order).
 */
export function sampleTrack(track: MotionTrack, t: number): number | null {
  const kfs = track.keyframes;
  if (kfs.length === 0) return null;
  if (kfs.length === 1) return kfs[0].value;

  // Sorted view (cheap; tracks are small). Keeps sampling robust to insert order.
  const sorted = isSorted(kfs) ? kfs : [...kfs].sort((a, b) => a.t - b.t);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (t <= first.t) return first.value;
  if (t >= last.t) return last.value;

  // Binary-search the segment [lo, hi] with sorted[lo].t <= t < sorted[hi].t.
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = sorted[lo];
  const b = sorted[hi];
  const span = b.t - a.t;
  const raw = span <= 0 ? 0 : (t - a.t) / span;
  const eased = EASING[b.easing ?? 'linear'](clamp01(raw));
  return a.value + (b.value - a.value) * eased;
}

function isSorted(kfs: Keyframe[]): boolean {
  for (let i = 1; i < kfs.length; i++) {
    if (kfs[i].t < kfs[i - 1].t) return false;
  }
  return true;
}

/**
 * Sample every track in a clip at time `t`. Returns a Map keyed by
 * `trackKey(nodeId, param)` -> value; tracks that resolve to null (empty) are
 * omitted so callers can fall back to the live param.
 */
export function sampleClip(clip: MotionClip, t: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const track of clip.tracks) {
    const v = sampleTrack(track, t);
    if (v != null) out.set(trackKey(track.nodeId, track.param), v);
  }
  return out;
}

/**
 * The resolved value used to drive a node's gradient/ring + orb motion: the
 * bound track sampled at `t` if one exists (and is non-empty), else the live
 * workflow value. `param` selects which of the node's tracks to read (the
 * default-track param; see binding.defaultTrackParam).
 */
export function clipValueForOrb(
  clip: MotionClip,
  node: { id: string },
  t: number,
  liveValue: number,
  param?: string,
): number {
  const track = clip.tracks.find(
    (tr) => tr.nodeId === node.id && (param === undefined || tr.param === param),
  );
  if (track) {
    const sampled = sampleTrack(track, t);
    if (sampled != null) return sampled;
  }
  return liveValue;
}
