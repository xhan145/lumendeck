/**
 * Wall-clock playback stepper + frame driver for the Motion Engine.
 *
 * WHY A WALL CLOCK, NOT A BARE rAF COUNTER: the playhead must advance by REAL
 * elapsed time (performance.now() deltas), never by "how many rAF callbacks
 * fired". A bare requestAnimationFrame loop that increments a local `t` only
 * ticks when the page produces frames — hidden/occluded desktop windows and
 * headless/preview harnesses starve rAF indefinitely, so the clock would freeze
 * (the v0.13.1 flushScheduler starvation bug, re-broken by the first playback
 * loop). This module therefore:
 *   1. computes advance purely from elapsed wall time (advancePlayback), and
 *   2. drives the tick from BOTH an animation frame (smooth when visible) AND a
 *      short timer fallback (~30ms) — whichever fires first runs the step and
 *      re-arms — exactly the flushScheduler pattern, so a minimized/occluded/
 *      hidden window still advances the playhead and animates orbs.
 *
 * The stepper (advancePlayback) is a pure function: no DOM, no three.js, fully
 * unit-testable without a browser (see tests/motion.test.ts).
 *
 * Time is in SECONDS; wall time (`now`/dt) is in the caller's clock units
 * (performance.now() milliseconds in production).
 */

export interface PlaybackAdvanceInput {
  /** Current playhead time (seconds). */
  t: number;
  /** Elapsed WALL time since the last step (seconds, clamped to >= 0 by caller). */
  dt: number;
  /** Playback rate multiplier (>= 0). */
  rate: number;
  /** Clip duration (seconds). */
  duration: number;
  /** Whether the clip loops at the end. */
  loop: boolean;
}

export interface PlaybackAdvanceResult {
  /** The new playhead time (seconds). */
  t: number;
  /**
   * True when a non-looping clip has reached (or passed) its end this step. The
   * caller should render the final frame then stop/settle playback. Looping
   * clips never "end" — they wrap and this stays false.
   */
  ended: boolean;
}

/**
 * Advance the playhead by real elapsed wall time. Pure + deterministic.
 * - Looping clips wrap with modulo (never "end").
 * - Non-looping clips clamp to `duration` and report `ended: true`.
 * - A zero/negative duration is treated as instantly ended (non-looping) or
 *   pinned at 0 (looping) so callers never divide by zero.
 */
export function advancePlayback({ t, dt, rate, duration, loop }: PlaybackAdvanceInput): PlaybackAdvanceResult {
  const next = t + Math.max(0, dt) * (rate > 0 ? rate : 0);
  if (duration <= 0) {
    return loop ? { t: 0, ended: false } : { t: 0, ended: true };
  }
  if (next >= duration) {
    if (loop) return { t: next % duration, ended: false };
    return { t: duration, ended: true };
  }
  return { t: next, ended: false };
}

/** Injected timing hooks so the driver is testable without a real browser clock. */
export interface PlaybackDriverHooks {
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
}

export interface PlaybackDriver {
  /** Stop the loop: cancels any armed frame/timer. Safe to call when stopped. */
  stop(): void;
  /** True while a frame or timer is armed (for tests/diagnostics). */
  running(): boolean;
}

/**
 * Fallback delay: longer than one 60Hz frame so a visible window's rAF always
 * wins (smooth playback, no behavior change), short enough (~33ms ≈ 30Hz) that a
 * frame-starved window still advances the playhead promptly. Mirrors
 * flushScheduler.FLUSH_FALLBACK_MS.
 */
export const PLAYBACK_FALLBACK_MS = 30;

/**
 * Run `tick` repeatedly, driven by whichever of an animation frame OR a short
 * timer fires first (then re-arm). This is the starvation-proof loop: rAF gives
 * smooth vsync-aligned playback when the window is visible, and the timer keeps
 * the playhead advancing when rAF is starved (hidden/minimized/occluded/headless).
 *
 * `tick` returns `false` to stop the loop (e.g. the clip ended or was deleted);
 * returning `true` (or void) re-arms for the next step.
 */
export function createPlaybackDriver(
  tick: () => boolean | void,
  hooks: PlaybackDriverHooks,
): PlaybackDriver {
  let frameId: number | null = null;
  let timerId: number | null = null;
  let stopped = false;

  const disarm = () => {
    if (frameId != null) hooks.cancelFrame(frameId);
    if (timerId != null) hooks.clearTimer(timerId);
    frameId = null;
    timerId = null;
  };

  const arm = () => {
    if (stopped) return;
    frameId = hooks.requestFrame(() => {
      frameId = null;
      fire('timer');
    });
    timerId = hooks.setTimer(() => {
      timerId = null;
      fire('frame');
    }, PLAYBACK_FALLBACK_MS);
  };

  const fire = (other: 'frame' | 'timer') => {
    // Cancel the sibling so exactly one tick runs per armed pair.
    if (other === 'timer' && timerId != null) hooks.clearTimer(timerId);
    if (other === 'frame' && frameId != null) hooks.cancelFrame(frameId);
    frameId = null;
    timerId = null;
    if (stopped) return;
    const keepGoing = tick();
    if (keepGoing === false) {
      stopped = true;
      return;
    }
    arm();
  };

  arm();

  return {
    stop() {
      stopped = true;
      disarm();
    },
    running: () => !stopped && (frameId != null || timerId != null),
  };
}
