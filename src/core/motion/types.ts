/**
 * Motion Engine (Phase 1 of the Living Constellation) shared types.
 *
 * These are the canonical shapes the whole motion feature is built on: the
 * pure interpolation/orb-motion/render-plan layer, the persisted store slice,
 * and the UI timeline all import from here. See
 * docs/superpowers/specs/2026-07-06-motion-engine-phase1-design.md.
 *
 * Time convention: all `t`/`duration` values are in SECONDS.
 */

/** Easing applied across a keyframe segment (unit-interval fns live in EASING). */
export type EasingKind =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'smoothstep'
  | 'step';

/** A single keyframe on a track: value at time `t`, with optional incoming easing. */
export interface Keyframe {
  /**
   * STABLE identity, independent of array position. The store keeps a track's
   * keyframes sorted by `t`, so a keyframe's array index changes whenever a drag
   * or nudge crosses a neighbor. Editing by index therefore re-timed the WRONG
   * keyframe (silent data loss — motion edits have no undo); editing by this id
   * is drag/re-sort safe. Older persisted clips predate ids and have them
   * assigned on hydrate (see hydrateMotion).
   */
  id: string;
  /** Seconds, 0..clip.duration. */
  t: number;
  value: number;
  /** Easing applied on the segment ENDING at this keyframe (default 'linear'). */
  easing?: EasingKind;
}

/**
 * A value curve bound to one numeric ParamDef of a node's capsule. The param is
 * validated with `isBindable(kind, param)`; the param's min/max define the
 * value domain (not enforced here — authored values are stored verbatim).
 */
export interface MotionTrack {
  id: string;
  nodeId: string;
  /** numeric ParamDef id on that node's capsule */
  param: string;
  keyframes: Keyframe[];
}

/**
 * How an orb moves in 3D over time. This is a *spatial* view of a value; it is
 * parameterized by the orb's resolved value (`valueT`, normalized 0..1) so, e.g.,
 * orbit radius scales with the value. `t` is seconds; motion is deterministic.
 */
export interface OrbMotion {
  style: 'orbit' | 'bob' | 'pulse' | 'drift' | 'still';
  speed: number;
  amplitude: number;
}

/** One authored clip: tracks (value curves) + per-node orb motions. */
export interface MotionClip {
  id: string;
  name: string;
  /** seconds */
  duration: number;
  fps: number;
  loop: boolean;
  tracks: MotionTrack[];
  /** keyed by nodeId */
  orbMotions: Record<string, OrbMotion>;
}

/** Persisted slice: authored clips + which one is active. Transport is ephemeral. */
export interface MotionState {
  clips: MotionClip[];
  activeClipId: string | null;
}

/**
 * Ephemeral transport (playhead) state. NEVER persisted — the 3D/UI layer runs
 * the actual rAF advance and calls `seek`; the store only holds the position.
 */
export interface TransportState {
  playing: boolean;
  /** current playhead time in seconds */
  t: number;
  playbackRate: number;
}
