/**
 * Pure frame-time instrumentation for the 3D graph. No DOM, no three.js — the
 * caller feeds per-render deltas and the renderer's draw-call count; this module
 * only aggregates. Fully unit-testable (tests/frameStats.test.ts).
 *
 * Phase 0 of the constellation GPU overhaul: "instrumentation before effect."
 */

export interface FrameStats {
  /** Exponential-moving-average frame time in milliseconds. */
  frameMs: number;
  /** EMA-derived frames per second (1000 / frameMs). */
  fps: number;
  /** Worst (max) frame time over the recent sample window, milliseconds. */
  worstMs: number;
  /** Most recent draw-call count (renderer.info.render.calls), 0 if unset. */
  drawCalls: number;
  /** Frames sampled since the last reset. */
  samples: number;
}

export interface FrameStatsAccumulator {
  /** Record one rendered frame's duration (ms since the previous render). */
  sample(dtMs: number): void;
  /** Record the current draw-call count (renderer.info.render.calls). */
  setDrawCalls(calls: number): void;
  /** Current aggregated stats (cheap; safe to call every publish tick). */
  read(): FrameStats;
  /** Clear all history (e.g. on view remount). */
  reset(): void;
}

const DEFAULT_ALPHA = 0.1; // EMA smoothing (higher = snappier)
const DEFAULT_WINDOW = 120; // worst-frame window (~2s at 60fps)

function clampAlpha(a: number): number {
  if (!Number.isFinite(a)) return DEFAULT_ALPHA;
  return Math.min(1, Math.max(0.001, a));
}

export function createFrameStats(opts?: { emaAlpha?: number; windowSize?: number }): FrameStatsAccumulator {
  const alpha = clampAlpha(opts?.emaAlpha ?? DEFAULT_ALPHA);
  const windowSize = Math.max(1, Math.floor(opts?.windowSize ?? DEFAULT_WINDOW));
  const ring = new Float64Array(windowSize);
  let ringLen = 0;
  let ringHead = 0;
  let frameMs = 0;
  let drawCalls = 0;
  let samples = 0;

  return {
    sample(dtMs: number) {
      if (!Number.isFinite(dtMs) || dtMs < 0) return;
      frameMs = samples === 0 ? dtMs : alpha * dtMs + (1 - alpha) * frameMs;
      ring[ringHead] = dtMs;
      ringHead = (ringHead + 1) % windowSize;
      if (ringLen < windowSize) ringLen++;
      samples++;
    },
    setDrawCalls(calls: number) {
      if (Number.isFinite(calls) && calls >= 0) drawCalls = calls;
    },
    read(): FrameStats {
      let worst = 0;
      for (let i = 0; i < ringLen; i++) if (ring[i] > worst) worst = ring[i];
      return { frameMs, fps: frameMs > 0 ? 1000 / frameMs : 0, worstMs: worst, drawCalls, samples };
    },
    reset() {
      ringLen = 0;
      ringHead = 0;
      frameMs = 0;
      drawCalls = 0;
      samples = 0;
    },
  };
}
