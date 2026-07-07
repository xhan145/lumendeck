/**
 * Ghost path → Motion clip conversion (closes the Living Constellation loop:
 * spatial performance → recorded animation → rendered video). Pure + unit-tested;
 * the store wires it to the motion slice (addTrack/addKeyframe equivalents).
 *
 * A recorded path is a list of `{ t, pos }` samples. For each param the profile
 * drives, we emit ONE MotionTrack whose keyframes hold that param's value at each
 * sample's position (evaluated at FULL intensity, so the recorded curve reflects
 * exactly where the ghost was). Keyframes get stable ids via `uid('kf')`, exactly
 * like the motion slice's addKeyframe.
 */
import { uid } from '../workflow';
import type { Keyframe, MotionClip, MotionTrack } from '../motion/types';
import { applyField } from './applyField';
import { profileEntries, type FieldProfile } from './fieldProfile';

/** One sampled point on a ghost's recorded path. `t` in seconds. */
export interface PathSample {
  t: number;
  pos: { x: number; y: number; z: number };
}

/**
 * Convert a sampled ghost path into a playable MotionClip.
 *
 * - One track per field-mapped param (in profile x,y,z / bundle order).
 * - One keyframe per sample on each track, at the sample's `t`, holding the
 *   param value `applyField(pos, 1, profile, nodeId)` resolves for that pos.
 * - Clip duration = the last sample's `t` (0 when empty), fps left at the motion
 *   default so playback/render (Phases 1+2) consume it unchanged.
 *
 * An empty profile or empty sample list yields a clip with no tracks. Pure.
 */
export function pathToClip(samples: PathSample[], profile: FieldProfile, nodeId: string): MotionClip {
  // No samples means nothing was recorded — emit a clip with NO tracks (rather
  // than empty-keyframe tracks) so callers can treat it as "nothing to play".
  const entries = samples.length > 0 ? profileEntries(profile) : [];
  const duration = samples.length > 0 ? Math.max(0, samples[samples.length - 1].t) : 0;

  // Precompute each sample's param values once (avoids re-running applyField per track).
  const valuesPerSample = samples.map((s) => {
    const patches = applyField(s.pos, 1, profile, nodeId);
    const byParam = new Map<string, number>();
    for (const p of patches) byParam.set(p.param, p.value);
    return byParam;
  });

  const tracks: MotionTrack[] = entries.map((e) => {
    const keyframes: Keyframe[] = samples.map((s, i) => {
      const value = valuesPerSample[i].get(e.param) ?? 0;
      return { id: uid('kf'), t: Math.max(0, s.t), value };
    });
    return { id: uid('track'), nodeId, param: e.param, keyframes };
  });

  return {
    id: uid('clip'),
    name: 'Ghost recording',
    duration,
    fps: 24,
    loop: false,
    tracks,
    orbMotions: {},
  };
}
