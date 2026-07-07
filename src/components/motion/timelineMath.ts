/**
 * Pure timeline geometry + formatting helpers for the Motion Timeline panel.
 *
 * No DOM, no React, no store — just the math that maps between clip time
 * (seconds) and pixel positions on the scrubber / keyframe lanes, plus the
 * transport time-readout formatter. Extracted so the interaction code in
 * MotionTimeline.tsx stays thin and every mapping is unit-tested
 * (tests/motionUi.test.ts) without a browser.
 */

/**
 * Clamp x into [lo, hi]. All callers pass a well-ordered range (lo <= hi); on a
 * degenerate inverted range `hi` wins (it is applied last).
 */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * Map a clip time (seconds) to an x offset in pixels across a lane of `width`
 * px spanning [0, duration]. Times outside the range clamp to the ends; a
 * zero/negative duration collapses to x=0 (avoids divide-by-zero).
 */
export function timeToX(t: number, duration: number, width: number): number {
  if (!(duration > 0) || !(width > 0)) return 0;
  return clamp(t / duration, 0, 1) * width;
}

/**
 * Inverse of `timeToX`: map an x offset in pixels (0..width) back to a clip
 * time (seconds) in [0, duration]. Out-of-range x clamps to the ends; a
 * zero/negative duration or width yields t=0.
 */
export function xToTime(x: number, duration: number, width: number): number {
  if (!(duration > 0) || !(width > 0)) return 0;
  return clamp(x / width, 0, 1) * duration;
}

/** Fraction 0..1 of a time within the clip duration (for CSS percent left). */
export function timeFraction(t: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return clamp(t / duration, 0, 1);
}

/**
 * Format seconds as `M:SS.d` (minutes, zero-padded seconds, one decimal) for
 * the transport readout — e.g. 0 -> "0:00.0", 3.25 -> "0:03.2", 72.4 ->
 * "1:12.4". Negative/NaN inputs read as "0:00.0".
 */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${mins}:${String(whole).padStart(2, '0')}.${tenths}`;
}

/** Playback-rate label, e.g. 1 -> "1x", 0.5 -> "0.5x", 2 -> "2x". */
export function formatRate(rate: number): string {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  // Trim a trailing ".0" so whole rates read cleanly (2x not 2.0x).
  const text = Number.isInteger(r) ? String(r) : String(Number(r.toFixed(2)));
  return `${text}x`;
}
