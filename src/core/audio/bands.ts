/**
 * Audio Reactivity (Living Constellation Phase 3) — pure frequency-band analysis.
 *
 * HONEST FRAMING: this is straight signal math over a Web Audio AnalyserNode's
 * byte FFT (`getByteFrequencyData`, 0..255 per bin). No ML, no fetch, no DOM —
 * every function here is deterministic and unit-tested with a synthetic
 * Uint8Array (tests never touch a real AudioContext). See
 * docs/superpowers/specs/2026-07-06-audio-reactivity-phase3-design.md.
 *
 * All band outputs are normalized to 0..1 (byte value / 255), so downstream
 * mapping/clip code is amplitude-agnostic.
 */

/** The four canonical band energies a mapping can react to (each 0..1). */
export interface Bands {
  bass: number;
  mid: number;
  treble: number;
  /** overall loudness (mean of ALL bins) */
  level: number;
}

/**
 * Where the bass/mid/treble split points fall as FRACTIONS of the FFT bin
 * range [0,1]. Low frequencies occupy the first handful of bins, so the default
 * puts bass in the lowest ~12%, mid up to ~40%, treble the rest.
 */
export interface BandLayout {
  /** fraction [0,1] where bass ends / mid begins */
  bassEnd: number;
  /** fraction [0,1] where mid ends / treble begins */
  midEnd: number;
}

export const DEFAULT_LAYOUT: BandLayout = { bassEnd: 0.12, midEnd: 0.4 };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Mean of the bins in the fractional range [loFrac, hiFrac) of `data`, divided
 * by 255 so the result is 0..1. The range is at least one bin wide (so a thin
 * band never divides by zero) and is clamped to the array bounds.
 */
function meanFraction(data: Uint8Array, loFrac: number, hiFrac: number): number {
  const n = data.length;
  if (n === 0) return 0;
  const lo = Math.max(0, Math.min(n - 1, Math.floor(clamp01(loFrac) * n)));
  const hi = Math.max(lo + 1, Math.min(n, Math.ceil(clamp01(hiFrac) * n)));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += data[i];
  return clamp01(sum / ((hi - lo) * 255));
}

/**
 * Reduce a byte FFT frame into normalized bass/mid/treble/level bands.
 *
 * - `bass`   = mean of bins in [0, bassEnd)
 * - `mid`    = mean of bins in [bassEnd, midEnd)
 * - `treble` = mean of bins in [midEnd, 1)
 * - `level`  = mean of ALL bins
 *
 * Each is byte-mean / 255, so all outputs are 0..1. Pure + deterministic.
 */
export function computeBands(freqData: Uint8Array, layout: BandLayout = DEFAULT_LAYOUT): Bands {
  const n = freqData.length;
  if (n === 0) return { bass: 0, mid: 0, treble: 0, level: 0 };
  const bassEnd = clamp01(layout.bassEnd);
  const midEnd = Math.max(bassEnd, clamp01(layout.midEnd));
  let total = 0;
  for (let i = 0; i < n; i++) total += freqData[i];
  return {
    bass: meanFraction(freqData, 0, bassEnd),
    mid: meanFraction(freqData, bassEnd, midEnd),
    treble: meanFraction(freqData, midEnd, 1),
    level: clamp01(total / (n * 255)),
  };
}

/**
 * Split a byte FFT frame into `n` contiguous equal-width bands, each the
 * normalized (0..1) mean of its bins. Used for a finer N-band spectrum (e.g. a
 * meter or a many-orb mapping). `n` is clamped to >= 1; an empty frame yields
 * `n` zeros. Pure + deterministic.
 */
export function computeNBands(freqData: Uint8Array, n: number): number[] {
  const bands = Math.max(1, Math.floor(n));
  const out: number[] = [];
  // meanFraction returns 0 on an empty frame, so len===0 yields `bands` zeros.
  for (let b = 0; b < bands; b++) {
    out.push(meanFraction(freqData, b / bands, (b + 1) / bands));
  }
  return out;
}

/**
 * One-pole smoothing (exponential moving average) so band-driven motion doesn't
 * jitter frame to frame. `factor` is the INERTIA in [0,1]:
 *   - factor 0 -> output = `next` (no smoothing, fully responsive)
 *   - factor 1 -> output = `prev` (frozen)
 * The output always lies within [min(prev,next), max(prev,next)], so repeated
 * application with a fixed `next` converges monotonically to `next` (for
 * factor < 1). `factor` is clamped to [0,1]. Pure.
 */
export function smooth(prev: number, next: number, factor: number): number {
  const k = factor < 0 ? 0 : factor > 1 ? 1 : factor;
  return prev * k + next * (1 - k);
}

/** Scale every band by `k` (sensitivity), re-clamped to 0..1. Pure. */
export function scaleBands(bands: Bands, k: number): Bands {
  const s = (v: number) => clamp01(v * k);
  return { bass: s(bands.bass), mid: s(bands.mid), treble: s(bands.treble), level: s(bands.level) };
}
