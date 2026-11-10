import type { FileStar } from './fileMap';
import type { FileTimeBounds } from './fileTime';
import { clampTimeProgress, fileTimeAt } from './fileTime';

export type FileSpectrumMode = 'off' | 'gradient' | 'drift';

/** Spectrum (S) is a display encoding, not a new physical file property. */
export interface FileSpectrumSignal {
  /** 0..1 closeness of an observed modification date to the 4D playhead. */
  temporal: number | null;
  /** 0..1 local filename/kind/date heuristic from the active 5D lens. */
  contextual: number;
  /** Bounded composite, used for a color shift rather than an assertion. */
  energy: number;
}

export const SPECTRUM_GRADIENT_DARK = [0.60, 0.73, 1.11] as const;
export const SPECTRUM_GRADIENT_LIGHT = [1.34, 0.91, 1.19] as const;

export function spectrumSignal(
  star: FileStar, bounds: FileTimeBounds | null,
  playhead: number, contextScore: number,
): FileSpectrumSignal {
  const modified = star.entry.modifiedMs;
  let temporal: number | null = null;
  if (bounds?.distinctDates && modified !== null &&
      Number.isFinite(modified) && modified >= 0 &&
      modified >= bounds.firstMs && modified <= bounds.lastMs) {
    const span = Math.max(1, bounds.lastMs - bounds.firstMs);
    const distance = Math.abs(modified - fileTimeAt(bounds, clampTimeProgress(playhead))) / span;
    temporal = Math.max(0, 1 - distance * 2.2);
  }
  const contextual = Number.isFinite(contextScore)
    ? Math.min(1, Math.max(0, contextScore / 100)) : 0;
  // No valid date means no temporal contribution, not an invented timestamp.
  const energy = Math.min(1, Math.max(0, (temporal ?? 0) * 0.57 + contextual * 0.43));
  return { temporal, contextual, energy };
}

function parseHex(hex: string): [number, number, number] {
  const value = /^#[\da-fA-F]{6}$/.test(hex) ? hex : '#9e90c5';
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function blendHex(a: string, b: string, amount: number): string {
  const start = parseHex(a);
  const end = parseHex(b);
  const t = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
  return '#' + start.map((n, i) =>
    Math.round(n + (end[i] - n) * t).toString(16).padStart(2, '0')).join('');
}

/**
 * Per-star type identity remains the dominant color. S enriches its hue
 * with time/context evidence, plus a subtle optional motion component.
 * No arbitrary color means a file was edited, damaged, or inspected.
 */
export function spectrumStarColor(
  star: FileStar,
  signal: FileSpectrumSignal,
  mode: FileSpectrumMode,
  selected: boolean,
  hovered: boolean,
  elapsedSeconds: number,
  allowMotion: boolean,
): string {
  if (mode === 'off') return selected ? '#ffffff' : star.color;
  const timeShift = signal.temporal === null ? 0 : 0.24 * signal.temporal;
  const contextShift = 0.38 * signal.contextual;
  const energyShift = 0.16 * signal.energy;
  const stable = Math.min(0.68, timeShift + contextShift + energyShift);
  // Periodic color changes are cosmetic, always bounded, and freeze when
  // the OS requests reduced motion. The underlying evidence is unchanged.
  const drift = mode === 'drift' && allowMotion
    ? 0.08 * (0.5 + 0.5 * Math.sin(elapsedSeconds * 0.65 +
      star.x * 0.7 + star.z * 0.2)) : 0;
  const colored = blendHex(star.color, '#dbc2f7', stable + drift);
  if (selected) return blendHex(colored, '#ffffff', 0.58);
  if (hovered) return blendHex(colored, '#eee2ff', 0.28);
  return colored;
}

export function spectrumCssGradient(
  baseColor: string,
  signal: FileSpectrumSignal,
): string {
  const light = blendHex(baseColor, '#e3cffa', 0.30 + 0.38 * signal.energy);
  const deep = blendHex(baseColor, '#343052', 0.36);
  return `linear-gradient(135deg, ${light}, ${deep})`;
}
