/**
 * Pure drag/angle math for the Render-Space Ghost Controller (v0.16.0). NO DOM,
 * NO three.js — fully unit-testable (see tests/ghostUi.test.ts).
 *
 * Two independent controls live here:
 *  - The equatorial RING DIAL maps a pointer angle around an orb to that node's
 *    primary value across [min, max] (0° = min, 180° = mid, ~360° = max).
 *  - The GHOST maps a dragged world position, relative to its origin orb, into
 *    the field's normalized [0,1]-per-axis space (and back), so `applyField`/
 *    `fieldPosition` (in src/core/field/*) can turn that into param patches.
 *
 * Honest framing: the field these coordinates drive is a DETERMINISTIC curated
 * parameter field, not a trained/learned model. All math here is reproducible.
 */

const TWO_PI = Math.PI * 2;

/** Clamp x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Clamp x into [0, 1]. */
export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/**
 * Angle (radians, 0..2π) of a pointer at (px, py) around a center (cx, cy),
 * measured CLOCKWISE from straight up (12 o'clock) so the dial reads like a
 * conventional gauge: up = 0, right = 90°, down = 180°, left = 270°.
 *
 * Screen space is y-DOWN, so "up" is -y. Using atan2(dx, -dy) gives the
 * clockwise-from-up angle directly; the result is normalized into [0, 2π).
 */
export function pointerAngle(cx: number, cy: number, px: number, py: number): number {
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return 0;
  let a = Math.atan2(dx, -dy); // clockwise from up, in (-π, π]
  if (a < 0) a += TWO_PI;
  return a;
}

/**
 * Map a dial angle (radians) to a normalized value in [0, 1]: 0° -> 0,
 * 180° -> 0.5, ~360° -> 1. The angle is taken modulo 2π so wrapping past the
 * top does not jump; exactly 2π is treated as a full turn (1), NOT 0.
 */
export function angleToT(angle: number): number {
  // A dial dragged to exactly one full turn reads as the max (1), not 0. Any
  // OTHER angle (including past a full turn) wraps into [0, 2π) first.
  if (angle === TWO_PI) return 1;
  const a = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
  return a / TWO_PI;
}

/** Inverse of `angleToT`: a normalized value in [0,1] back to a dial angle 0..2π. */
export function tToAngle(t: number): number {
  return clamp01(t) * TWO_PI;
}

/** Map a dial angle to an actual param value across [min, max] (clamped). */
export function angleToValue(angle: number, min: number, max: number): number {
  return min + angleToT(angle) * (max - min);
}

/**
 * The pointer maps to a value on the ring dial for a node whose primary weight
 * spans [min, max]. Convenience wrapper: pointer position -> concrete value.
 */
export function ringValueFromPointer(
  cx: number,
  cy: number,
  px: number,
  py: number,
  min: number,
  max: number,
): number {
  return angleToValue(pointerAngle(cx, cy, px, py), min, max);
}

/**
 * Hit-test a pointer against an orb's equatorial ring band (the draggable dial)
 * vs. the orb body. Returns 'ring' when the pointer's distance from the orb
 * center (in the projected 2D plane) falls within [radius - inner, radius +
 * outer]; 'body' when inside that band's inner edge; 'outside' beyond it.
 *
 * `band` widens the torus tube into a forgiving pointer target so the ring is
 * grabbable without pixel precision, while a press nearer the center still
 * reads as a body drag / click-to-expand.
 */
export function hitRingBand(
  cx: number,
  cy: number,
  px: number,
  py: number,
  radius: number,
  band: { inner: number; outer: number },
): 'ring' | 'body' | 'outside' {
  const dist = Math.hypot(px - cx, py - cy);
  if (dist >= radius - band.inner && dist <= radius + band.outer) return 'ring';
  if (dist < radius - band.inner) return 'body';
  return 'outside';
}

/**
 * Half-extent (world units) of the ghost's field cube along each axis: a ghost
 * dragged this far from its origin orb, in world space, spans the full [0,1] of
 * that axis. Keeps the ghost's reach comfortably larger than the orb itself.
 */
export const GHOST_FIELD_EXTENT = 260;

/**
 * Normalize a ghost's world position (relative to its origin orb center) into
 * the field's [0,1]³ space. Center of the cube (on the orb) maps to 0.5 on every
 * axis (the field midpoint), each end of the cube to 0 / 1. Values are clamped.
 *
 * World is y-UP; the field's Y axis follows world y (up = higher value). X and Z
 * follow world x/z directly. `extent` is the half-cube size (see GHOST_FIELD_EXTENT).
 */
export function worldToFieldPos(
  ghost: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  extent = GHOST_FIELD_EXTENT,
): { x: number; y: number; z: number } {
  const norm = (g: number, o: number) => clamp01(0.5 + (g - o) / (2 * extent));
  return { x: norm(ghost.x, origin.x), y: norm(ghost.y, origin.y), z: norm(ghost.z, origin.z) };
}

/**
 * Inverse of `worldToFieldPos`: a field [0,1]³ position back to a ghost world
 * position offset from its origin orb. Round-trips `worldToFieldPos` for any
 * in-range input (out-of-range inputs are clamped on the forward pass, so only
 * the clamped position round-trips).
 */
export function fieldPosToWorld(
  pos: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  extent = GHOST_FIELD_EXTENT,
): { x: number; y: number; z: number } {
  const denorm = (p: number, o: number) => o + (clamp01(p) - 0.5) * 2 * extent;
  return { x: denorm(pos.x, origin.x), y: denorm(pos.y, origin.y), z: denorm(pos.z, origin.z) };
}

/**
 * Keyboard nudge on one field axis: shift `pos[axis]` by `delta` (typically
 * ±step), clamped to [0,1]. Returns a NEW position object. Used by the ghost's
 * arrow-key a11y contract (arrows nudge X/Z, with a modifier for Y).
 */
export function nudgeFieldPos(
  pos: { x: number; y: number; z: number },
  axis: 'x' | 'y' | 'z',
  delta: number,
): { x: number; y: number; z: number } {
  return { ...pos, [axis]: clamp01(pos[axis] + delta) };
}
