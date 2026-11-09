/**
 * Files Constellation camera ergonomics.
 * Pure values allow regression tests without WebGL or local filesystem access.
 */
export const FILE_ZOOM = {
  initialDistance: 25,
  minDistance: 1.35,
  maxDistance: 82,
  focusDistance: 4.8,
  wheelSpeed: 3,
  buttonFactor: 0.60,
  transitionMs: 280,
} as const;

export type FileZoomAction = 'in' | 'out' | 'focus' | 'reset';

export function nextFileZoomDistance(
  currentDistance: number,
  factor: number,
  minDistance = FILE_ZOOM.minDistance,
  maxDistance = FILE_ZOOM.maxDistance,
): number {
  const current = Number.isFinite(currentDistance) && currentDistance > 0
    ? currentDistance
    : FILE_ZOOM.initialDistance;
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return Math.max(minDistance, Math.min(maxDistance, current * scale));
}

/** Keyboard commands apply only while the constellation viewport is focused. */
export function fileZoomActionFromKey(key: string, code: string): FileZoomAction | null {
  if (code === 'NumpadAdd' || key === '+' || key === '=') return 'in';
  if (code === 'NumpadSubtract' || key === '-' || key === '_') return 'out';
  if (key === '0' || code === 'Numpad0') return 'reset';
  if (key.toLowerCase() === 'f') return 'focus';
  return null;
}
