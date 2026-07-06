/**
 * Frame-independent dirty-flag flush scheduler for the 3D graph. PURE logic
 * with injected timing hooks — fully unit-testable (see tests/orbNodes.test.ts).
 *
 * Why not plain requestAnimationFrame: rAF only fires when the page produces
 * frames. Hidden/backgrounded tabs and headless (frame-on-demand) browsers can
 * starve rAF indefinitely, which left the CSS3D DOM (node cards/chips) stale
 * relative to the store — a node added from the palette never appeared until
 * something else forced a frame. The scheduler therefore arms BOTH an
 * animation frame (fast path, vsync-aligned when visible) and a short timer
 * fallback; whichever fires first runs the flush and cancels the other.
 *
 * Invariants:
 * - Requests while a flush is pending coalesce into that single flush.
 * - After a flush (or cancel) the scheduler is fully idle: no frames, no
 *   timers — the render loop provably sleeps between invalidations.
 */

export interface FlushHooks {
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
}

/**
 * Fallback delay: longer than one 60Hz frame so a visible tab's rAF always
 * wins (no behavior change), short enough that DOM readers in frame-starved
 * environments see a consistent scene almost immediately.
 */
export const FLUSH_FALLBACK_MS = 34;

export interface FlushScheduler {
  /** Coalesce a flush request; no-op while one is already pending. */
  request(): void;
  /** Drop any pending flush (unmount). Safe to call when idle. */
  cancel(): void;
  /** True while a flush is armed (for tests/diagnostics). */
  pending(): boolean;
}

export function createFlushScheduler(flush: () => void, hooks: FlushHooks): FlushScheduler {
  let frameId: number | null = null;
  let timerId: number | null = null;

  const disarm = () => {
    if (frameId != null) hooks.cancelFrame(frameId);
    if (timerId != null) hooks.clearTimer(timerId);
    frameId = null;
    timerId = null;
  };

  const fire = (other: 'frame' | 'timer') => {
    if (other === 'timer' && timerId != null) hooks.clearTimer(timerId);
    if (other === 'frame' && frameId != null) hooks.cancelFrame(frameId);
    frameId = null;
    timerId = null;
    flush();
  };

  return {
    request() {
      if (frameId != null || timerId != null) return;
      frameId = hooks.requestFrame(() => {
        frameId = null;
        fire('timer');
      });
      timerId = hooks.setTimer(() => {
        timerId = null;
        fire('frame');
      }, FLUSH_FALLBACK_MS);
    },
    cancel: disarm,
    pending: () => frameId != null || timerId != null,
  };
}
