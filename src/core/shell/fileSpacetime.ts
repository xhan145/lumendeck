import type { FileFxMode } from '../../state/appSettings';
import type { FileContextMode } from './fileContext';

/**
 * Spacetime is a PRESENTATION layer for the existing fourth-dimensional
 * modification-time playhead, not recorded file history or a physics engine.
 */
export type FileSpacetimeMode = 'off' | 'contours' | 'flow';

export interface SpacetimeQuality {
  readonly horizontal: number;
  readonly vertical: number;
  readonly segments: number;
  readonly opacity: number;
}

export const SPACETIME_QUALITY: Readonly<Record<FileFxMode, SpacetimeQuality>> = {
  off: { horizontal: 0, vertical: 0, segments: 0, opacity: 0 },
  balanced: { horizontal: 9, vertical: 13, segments: 36, opacity: 0.12 },
  cinematic: { horizontal: 17, vertical: 23, segments: 64, opacity: 0.16 },
};

export const SPACETIME_FIELD_WIDTH = 40;
export const SPACETIME_FIELD_HEIGHT = 26;
export const SPACETIME_FIELD_DEPTH = -8.5;

export function spacetimeFocusStrength(
  selected: boolean, mode: FileContextMode, contextMatches: number,
): number {
  if (!selected) return 0;
  const count = Number.isFinite(contextMatches) ? Math.max(0, Math.min(18, contextMatches)) : 0;
  return Math.min(0.95, 0.45 + (mode === 'focus' ? 0.21 : mode === 'links' ? 0.11 : 0) +
    count / 18 * 0.18);
}

export function spacetimeFlowEnabled(
  mode: FileSpacetimeMode,
  timeEnabled: boolean,
  playing: boolean,
  reducedMotion: boolean,
  degraded: boolean,
): boolean {
  return mode === 'flow' && timeEnabled && playing && !reducedMotion && !degraded;
}

/**
 * One static GPU vertex buffer, two endpoints per grid segment.
 * Curvature and any motion happen in the vertex shader. No per-frame
 * rebuilding these vertices, no path or content reads.
 */
export function createSpacetimeLinePositions(quality: SpacetimeQuality): Float32Array {
  const horizontal = Math.max(0, Math.min(24, Math.floor(quality.horizontal || 0)));
  const vertical = Math.max(0, Math.min(32, Math.floor(quality.vertical || 0)));
  const segments = Math.max(0, Math.min(96, Math.floor(quality.segments || 0)));
  if (!segments || (!horizontal && !vertical)) return new Float32Array();
  const data = new Float32Array((horizontal + vertical) * segments * 6);
  let write = 0;
  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    data.set([x0, y0, SPACETIME_FIELD_DEPTH, x1, y1, SPACETIME_FIELD_DEPTH], write);
    write += 6;
  };
  for (let row = 0; row < horizontal; row++) {
    const y = (row / Math.max(1, horizontal - 1) - 0.5) * SPACETIME_FIELD_HEIGHT;
    for (let index = 0; index < segments; index++) {
      segment(
        (index / segments - 0.5) * SPACETIME_FIELD_WIDTH, y,
        ((index + 1) / segments - 0.5) * SPACETIME_FIELD_WIDTH, y,
      );
    }
  }
  for (let column = 0; column < vertical; column++) {
    const x = (column / Math.max(1, vertical - 1) - 0.5) * SPACETIME_FIELD_WIDTH;
    for (let index = 0; index < segments; index++) {
      segment(
        x, (index / segments - 0.5) * SPACETIME_FIELD_HEIGHT,
        x, ((index + 1) / segments - 0.5) * SPACETIME_FIELD_HEIGHT,
      );
    }
  }
  return data;
}
