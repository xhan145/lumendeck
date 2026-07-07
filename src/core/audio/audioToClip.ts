/**
 * Audio Reactivity (Phase 3) — bake a recorded reactive performance into a
 * Motion clip. Pure + unit-tested; the store wires it to the motion slice.
 *
 * A recorded performance is a list of `{ t, bands }` samples (wall-clock times,
 * normalized bands). For each mapping target that drives the baked `nodeId`, we
 * emit ONE MotionTrack whose keyframes hold that target's reaction value at each
 * sample time. This mirrors `pathToClip` conventions exactly: one track per
 * driven channel, one keyframe per sample, stable `uid('kf')`/`uid('track')`
 * ids, wall-clock keyframe times, empty input -> a clip with no tracks.
 *
 * HONEST FRAMING: the baked channels are VIEW-ONLY orb reactions (offset / scale
 * / ring), consistent with the motion render note ("orb position/scale are
 * view-only") — the clip plays via Phase 1 (transport + timeline) and renders
 * via Phase 2 (the base workflow, animated params carried verbatim). The
 * channels are stored under an `audio:` param namespace so they never collide
 * with real capsule params.
 */
import { uid } from '../workflow';
import type { Keyframe, MotionClip, MotionTrack } from '../motion/types';
import { applyAudio, type AudioMapping, type AudioReaction, type AudioTarget } from './mapping';
import type { Bands } from './bands';

/** One recorded analysis frame: bands at wall-clock time `t` (seconds). */
export interface AudioSample {
  t: number;
  bands: Bands;
}

/** The synthetic track param a target's baked channel is stored under. */
export function audioTrackParam(kind: AudioTarget['kind']): string {
  return `audio:${kind}`;
}

/** The reaction value a single target contributes at one sample (its channel). */
function channelValue(reaction: AudioReaction, target: AudioTarget): number {
  switch (target.kind) {
    case 'x':
      return reaction.offsets.get(target.nodeId)?.dx ?? 0;
    case 'y':
      return reaction.offsets.get(target.nodeId)?.dy ?? 0;
    case 'z':
      return reaction.offsets.get(target.nodeId)?.dz ?? 0;
    case 'scale':
      return reaction.offsets.get(target.nodeId)?.scale ?? 1;
    case 'ring':
      return reaction.ringValues.get(target.nodeId) ?? 0;
  }
}

/**
 * Convert recorded audio samples into a playable MotionClip for `nodeId`.
 *
 * - One track per mapping target whose `nodeId` matches (in mapping order),
 *   deduped so two targets sharing a channel kind don't produce colliding
 *   `audio:<kind>` params (later duplicates are dropped).
 * - One keyframe per sample on each track, at the sample's `t`, holding that
 *   target's `channelValue` for the frame.
 * - Clip duration = last sample's `t` (0 when empty), loop OFF (a captured
 *   performance, not a loop), fps at the motion default so Phases 1+2 consume it
 *   unchanged.
 *
 * Empty samples OR no matching targets -> a clip with no tracks. Pure.
 */
export function audioToClip(samples: AudioSample[], mapping: AudioMapping, nodeId: string): MotionClip {
  // No samples means nothing was recorded — emit a clip with NO tracks (mirrors
  // pathToClip) so callers can treat it as "nothing to play".
  const seen = new Set<string>();
  const targets: AudioTarget[] =
    samples.length > 0
      ? mapping.targets.filter((t) => {
          if (t.nodeId !== nodeId) return false;
          if (seen.has(t.kind)) return false; // one track per (node, channel)
          seen.add(t.kind);
          return true;
        })
      : [];
  const duration = samples.length > 0 ? Math.max(0, samples[samples.length - 1].t) : 0;

  // Precompute each sample's full reaction once (avoids re-running applyAudio per track).
  const reactions = samples.map((s) => applyAudio(s.bands, mapping));

  const tracks: MotionTrack[] = targets.map((target) => {
    const keyframes: Keyframe[] = samples.map((s, i) => ({
      id: uid('kf'),
      t: Math.max(0, s.t),
      value: channelValue(reactions[i], target),
    }));
    return { id: uid('track'), nodeId, param: audioTrackParam(target.kind), keyframes };
  });

  return {
    id: uid('clip'),
    name: 'Audio reactive',
    duration,
    fps: 24,
    loop: false,
    tracks,
    orbMotions: {},
  };
}
