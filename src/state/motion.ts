/**
 * Persisted "Motion" slice: authored motion clips + which is active. This module
 * owns the slice SHAPE + hydration so the store stays lean and existing persisted
 * state (which predates this feature) loads gracefully — a missing slice is
 * seeded with an empty state plus the demo clip (see seedDemoClip).
 *
 * Transport (playhead) state is NEVER persisted and lives directly on the store.
 */
import { uid } from '../core/workflow';
import type { Workflow } from '../core/types';
import { seedDemoClip } from '../core/motion/demoClip';
import type { Keyframe, MotionClip, MotionState, MotionTrack, TransportState } from '../core/motion/types';

/**
 * Additive migration: keyframes authored before the stable-id fix (BUG 4) have
 * no `id`. Assign a deterministic one derived from the owning track id + array
 * position so the SAME old blob always hydrates to the same ids (stable across
 * reloads) and old saved state keeps loading. Keyframes that already have an id
 * are passed through untouched.
 */
function ensureKeyframeIds(track: MotionTrack): MotionTrack {
  let mutated = false;
  const keyframes: Keyframe[] = track.keyframes.map((kf, i) => {
    if (kf.id) return kf;
    mutated = true;
    return { ...kf, id: `${track.id}_k${i}` };
  });
  return mutated ? { ...track, keyframes } : track;
}

function migrateClipKeyframeIds(clip: MotionClip): MotionClip {
  let mutated = false;
  const tracks = clip.tracks.map((track) => {
    const next = ensureKeyframeIds(track);
    if (next !== track) mutated = true;
    return next;
  });
  return mutated ? { ...clip, tracks } : clip;
}

/** A brand-new, empty motion state (no clips, none active). */
export function emptyMotionState(): MotionState {
  return { clips: [], activeClipId: null };
}

/** Fresh, ephemeral transport at the origin, paused, 1x. */
export function defaultTransport(): TransportState {
  return { playing: false, t: 0, playbackRate: 1 };
}

/**
 * Hydrate the persisted motion slice against the current workflow:
 * - Missing/invalid slice -> empty state seeded with the demo clip.
 * - Present slice -> passed through, then the demo clip is (idempotently) seeded
 *   so a first-run-less upgrade still gains the demo. `seedDemoClip` is a no-op
 *   once the demo id exists (or the user deleted it and it re-seeds only if
 *   absent — deletion persists because the stored clips list wins on next load
 *   only when the demo id is still there; a removed demo will re-seed, matching
 *   the promptTools "new builtins re-added" behavior).
 */
export function hydrateMotion(persisted: MotionState | undefined, workflow: Workflow): MotionState {
  const base: MotionState =
    persisted && Array.isArray(persisted.clips)
      ? {
          // Assign ids to any pre-id keyframes (additive migration; old blobs load).
          clips: persisted.clips.map(migrateClipKeyframeIds),
          activeClipId: persisted.activeClipId ?? null,
        }
      : emptyMotionState();
  return seedDemoClip(base, workflow);
}

/** Build a fresh empty clip with sensible defaults. */
export function makeClip(name?: string): MotionClip {
  return {
    id: uid('clip'),
    name: name && name.trim() ? name.trim() : 'New clip',
    duration: 3,
    fps: 24,
    loop: true,
    tracks: [],
    orbMotions: {},
  };
}
