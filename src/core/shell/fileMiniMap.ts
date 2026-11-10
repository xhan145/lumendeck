import type { FileStar } from './fileMap';

export interface MiniMapBounds {
  minX: number; maxX: number; minY: number; maxY: number;
}
export interface MiniMapPoint { x: number; y: number; }

export const MINI_MAP_WIDTH = 212;
export const MINI_MAP_HEIGHT = 122;

/** Fixed bounds from the initial layout keep 4D animation from bouncing the map. */
export function createMiniMapBounds(stars: readonly FileStar[]): MiniMapBounds {
  let minX = -4, maxX = 4, minY = -4, maxY = 4;
  for (const star of stars) {
    if (!Number.isFinite(star.x) || !Number.isFinite(star.y)) continue;
    minX = Math.min(minX, star.x);
    maxX = Math.max(maxX, star.x);
    minY = Math.min(minY, star.y);
    maxY = Math.max(maxY, star.y);
  }
  return { minX: minX - 3.4, maxX: maxX + 3.4,
    minY: minY - 2.8, maxY: maxY + 2.8 };
}

export function projectMiniMapPoint(
  x: number, y: number,
  bounds: MiniMapBounds,
  width = MINI_MAP_WIDTH, height = MINI_MAP_HEIGHT,
): MiniMapPoint {
  const rx = Math.max(0.001, bounds.maxX - bounds.minX);
  const ry = Math.max(0.001, bounds.maxY - bounds.minY);
  const px = (x - bounds.minX) / rx;
  const py = (y - bounds.minY) / ry;
  return {
    x: Math.max(6, Math.min(width - 6, 6 + px * (width - 12))),
    y: Math.max(6, Math.min(height - 6, 6 + (1 - py) * (height - 12))),
  };
}

export function findMiniMapStar(
  xyz: Float32Array, x: number, y: number,
  bounds: MiniMapBounds, maxDistance = 11,
): number | null {
  let closest: number | null = null;
  let closestDistance = maxDistance * maxDistance;
  for (let i = 0; i < xyz.length / 3; i++) {
    const point = projectMiniMapPoint(xyz[i * 3], xyz[i * 3 + 1], bounds);
    const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (distance <= closestDistance) {
      closest = i;
      closestDistance = distance;
    }
  }
  return closest;
}
