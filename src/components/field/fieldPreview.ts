/**
 * Streaming-preview drag plumbing — PURE, no React, no store, no timers of its
 * own beyond a single settle timer. The store owns the monotonic supersede token
 * and the actual `runFieldPreview` render; this file only turns a noisy ghost/orb
 * drag stream into ONE fire per "settled" position so the GPU is never queued
 * more than ~1 deep (see the field-presets streaming-preview spec §"Live
 * streaming preview").
 *
 * Deliberately timer-based (NOT a bare rAF): a settle debounce must fire on a
 * wall clock even when the tab is occluded/headless, mirroring the rest of the
 * field/motion plumbing. Injectable timers keep it deterministic under
 * vi.useFakeTimers in tests.
 */

/** A normalized field position; each axis lives in [0,1]. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Called with the LATEST pushed position once the drag stream settles. */
export type FireFn = (pos: Vec3) => void;

/** Minimal timer surface so tests can inject fake timers deterministically. */
export interface DebounceTimers {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: DebounceTimers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SettleDebouncer {
  /**
   * Record a new drag position and (re)arm the settle timer. `fire` is invoked
   * with the LATEST pushed position once pushes stop for `delayMs`. A newer push
   * supersedes an older pending one (only the last position + last fire run), so
   * a rapid drag collapses to a single trailing call.
   */
  push(pos: Vec3, fire: FireFn): void;
  /** Cancel any pending fire (drag end / unmount / streaming toggled off). */
  cancel(): void;
}

/**
 * Build a settle debouncer: `fire(latestPos)` runs once the caller stops pushing
 * for `delayMs`. Rapid pushes reset the timer and supersede the pending position,
 * so only the final resting spot fires. `cancel()` clears any pending fire.
 */
export function createSettleDebouncer(
  delayMs = 150,
  timers: DebounceTimers = DEFAULT_TIMERS,
): SettleDebouncer {
  const wait = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
  let handle: unknown = null;
  let pending: { pos: Vec3; fire: FireFn } | null = null;

  const clearTimer = () => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
  };

  return {
    push(pos, fire) {
      // Newest push wins: overwrite the pending target + fire and restart the
      // settle window so mid-drag jitter never fires more than the trailing call.
      pending = { pos, fire };
      clearTimer();
      handle = timers.set(() => {
        handle = null;
        const p = pending;
        pending = null;
        if (p) p.fire(p.pos);
      }, wait);
    },
    cancel() {
      clearTimer();
      pending = null;
    },
  };
}

/**
 * Clamp a raw drag position into the field's [0,1]^3 space. Non-finite axes
 * collapse to 0 so a bad pointer/unproject can never send NaN into a render job.
 * Always returns a fresh object (safe to store).
 */
export function normalizePos(pos: Vec3): Vec3 {
  const c = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
  return { x: c(pos.x), y: c(pos.y), z: c(pos.z) };
}
