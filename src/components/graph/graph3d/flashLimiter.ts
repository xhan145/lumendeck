/**
 * Sliding-window flash/onset limiter (WCAG 2.3.1: no more than three flashes in
 * any one-second window). PURE — the caller passes `now`; there are no timers.
 * A single limiter is shared by every ripple/flash source so their COMBINED
 * onset rate never exceeds the cap, no matter how many events arrive at once.
 */

export interface FlashLimiter {
  /** Register an onset at `now`; returns true if allowed (and recorded), else false. */
  tryAdd(now: number): boolean;
  /** Onsets currently inside the rolling window ending at `now`. */
  activeCount(now: number): number;
}

export function createFlashLimiter(maxOnsets = 3, windowMs = 1000): FlashLimiter {
  const times: number[] = [];

  const prune = (now: number) => {
    const cutoff = now - windowMs;
    // Drop onsets that have aged out of the rolling window.
    while (times.length > 0 && times[0] <= cutoff) times.shift();
  };

  return {
    tryAdd(now: number): boolean {
      prune(now);
      if (times.length >= maxOnsets) return false;
      times.push(now);
      return true;
    },
    activeCount(now: number): number {
      prune(now);
      return times.length;
    },
  };
}
