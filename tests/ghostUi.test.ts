import { describe, expect, it } from 'vitest';
import {
  GHOST_FIELD_EXTENT,
  angleToT,
  angleToValue,
  clamp,
  clamp01,
  fieldPosToWorld,
  hitRingBand,
  nudgeFieldPos,
  pointerAngle,
  ringValueFromPointer,
  tToAngle,
  worldToFieldPos,
} from '../src/components/graph/graph3d/ghostGizmo';

const TWO_PI = Math.PI * 2;

describe('clamp helpers', () => {
  it('clamp bounds x into [lo, hi]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('clamp01 bounds into [0, 1]', () => {
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});

describe('pointerAngle (clockwise from 12 o\'clock, screen y-down)', () => {
  const cx = 100;
  const cy = 100;

  it('straight up is 0', () => {
    expect(pointerAngle(cx, cy, cx, cy - 50)).toBeCloseTo(0, 10);
  });

  it('right is a quarter turn (π/2)', () => {
    expect(pointerAngle(cx, cy, cx + 50, cy)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('straight down is a half turn (π)', () => {
    expect(pointerAngle(cx, cy, cx, cy + 50)).toBeCloseTo(Math.PI, 10);
  });

  it('left is three-quarters (3π/2), normalized into [0, 2π)', () => {
    expect(pointerAngle(cx, cy, cx - 50, cy)).toBeCloseTo((3 * Math.PI) / 2, 10);
  });

  it('center (zero vector) is a stable 0', () => {
    expect(pointerAngle(cx, cy, cx, cy)).toBe(0);
  });
});

describe('angleToT + inverse (0deg=min, 180deg=mid, ~360deg=max)', () => {
  it('maps the cardinal angles to 0, 0.25, 0.5, 0.75', () => {
    expect(angleToT(0)).toBe(0);
    expect(angleToT(Math.PI / 2)).toBeCloseTo(0.25, 10);
    expect(angleToT(Math.PI)).toBeCloseTo(0.5, 10);
    expect(angleToT((3 * Math.PI) / 2)).toBeCloseTo(0.75, 10);
  });

  it('treats a full turn (2π) as 1, NOT wrapping back to 0', () => {
    expect(angleToT(TWO_PI)).toBe(1);
    // just under a full turn approaches 1
    expect(angleToT(TWO_PI - 1e-6)).toBeGreaterThan(0.999);
  });

  it('wraps angles beyond a full turn back into range', () => {
    expect(angleToT(TWO_PI + Math.PI)).toBeCloseTo(0.5, 10);
  });

  it('tToAngle is the inverse of angleToT for t in [0,1)', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.99]) {
      expect(angleToT(tToAngle(t))).toBeCloseTo(t, 10);
    }
    // and clamps out-of-range t
    expect(tToAngle(-1)).toBe(0);
    expect(tToAngle(2)).toBeCloseTo(TWO_PI, 10);
  });
});

describe('angleToValue + ringValueFromPointer (value dial across [min,max])', () => {
  it('0deg = min, 180deg = mid, ~360deg = max', () => {
    expect(angleToValue(0, 0, 30)).toBe(0); // cfg 0..30 -> 0
    expect(angleToValue(Math.PI, 0, 30)).toBeCloseTo(15, 10); // mid
    expect(angleToValue(TWO_PI, 0, 30)).toBe(30); // max
  });

  it('respects non-zero mins (e.g. LoRA weight -1..2)', () => {
    expect(angleToValue(0, -1, 2)).toBe(-1);
    expect(angleToValue(Math.PI, -1, 2)).toBeCloseTo(0.5, 10);
    expect(angleToValue(TWO_PI, -1, 2)).toBe(2);
  });

  it('ringValueFromPointer converts a pointer position straight to a value', () => {
    const cx = 200;
    const cy = 200;
    // pointer straight down = 180deg = mid of 0..30 = 15
    expect(ringValueFromPointer(cx, cy, cx, cy + 60, 0, 30)).toBeCloseTo(15, 10);
    // pointer straight up = 0deg = min = 0
    expect(ringValueFromPointer(cx, cy, cx, cy - 60, 0, 30)).toBeCloseTo(0, 10);
    // pointer right = 90deg = quarter of 0..30 = 7.5
    expect(ringValueFromPointer(cx, cy, cx + 60, cy, 0, 30)).toBeCloseTo(7.5, 10);
  });
});

describe('hitRingBand (ring dial vs orb body vs empty space)', () => {
  const cx = 0;
  const cy = 0;
  const radius = 55;
  const band = { inner: 10, outer: 14 };

  it('a pointer on the ring band reads as "ring"', () => {
    expect(hitRingBand(cx, cy, radius, 0, radius, band)).toBe('ring'); // exactly on the ring
    expect(hitRingBand(cx, cy, radius + 10, 0, radius, band)).toBe('ring'); // just outside
    expect(hitRingBand(cx, cy, radius - 8, 0, radius, band)).toBe('ring'); // just inside
  });

  it('a pointer near the center reads as "body" (drag/expand, not the dial)', () => {
    expect(hitRingBand(cx, cy, 0, 0, radius, band)).toBe('body');
    expect(hitRingBand(cx, cy, 20, 0, radius, band)).toBe('body');
  });

  it('a pointer well beyond the ring reads as "outside"', () => {
    expect(hitRingBand(cx, cy, radius + band.outer + 5, 0, radius, band)).toBe('outside');
    expect(hitRingBand(cx, cy, 0, 200, radius, band)).toBe('outside');
  });

  it('the band edges are inclusive on both sides', () => {
    expect(hitRingBand(cx, cy, radius - band.inner, 0, radius, band)).toBe('ring');
    expect(hitRingBand(cx, cy, radius + band.outer, 0, radius, band)).toBe('ring');
    // one unit past the inner edge falls to body / outside
    expect(hitRingBand(cx, cy, radius - band.inner - 1, 0, radius, band)).toBe('body');
    expect(hitRingBand(cx, cy, radius + band.outer + 1, 0, radius, band)).toBe('outside');
  });
});

describe('worldToFieldPos + fieldPosToWorld (world <-> normalized [0,1] field)', () => {
  const origin = { x: 100, y: -50, z: 20 };

  it('the origin orb center maps to the field midpoint (0.5 on every axis)', () => {
    expect(worldToFieldPos(origin, origin)).toEqual({ x: 0.5, y: 0.5, z: 0.5 });
  });

  it('one full extent in +world maps to 1, in -world to 0 (per axis)', () => {
    const hi = { x: origin.x + GHOST_FIELD_EXTENT, y: origin.y + GHOST_FIELD_EXTENT, z: origin.z + GHOST_FIELD_EXTENT };
    const lo = { x: origin.x - GHOST_FIELD_EXTENT, y: origin.y - GHOST_FIELD_EXTENT, z: origin.z - GHOST_FIELD_EXTENT };
    expect(worldToFieldPos(hi, origin)).toEqual({ x: 1, y: 1, z: 1 });
    expect(worldToFieldPos(lo, origin)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('clamps positions beyond the field cube', () => {
    const way = { x: origin.x + GHOST_FIELD_EXTENT * 5, y: origin.y - GHOST_FIELD_EXTENT * 5, z: origin.z };
    expect(worldToFieldPos(way, origin)).toEqual({ x: 1, y: 0, z: 0.5 });
  });

  it('fieldPosToWorld inverts worldToFieldPos for in-range positions', () => {
    const ghost = { x: 180, y: -110, z: 5 };
    const pos = worldToFieldPos(ghost, origin);
    const back = fieldPosToWorld(pos, origin);
    expect(back.x).toBeCloseTo(ghost.x, 8);
    expect(back.y).toBeCloseTo(ghost.y, 8);
    expect(back.z).toBeCloseTo(ghost.z, 8);
  });

  it('fieldPosToWorld places the midpoint back on the origin', () => {
    expect(fieldPosToWorld({ x: 0.5, y: 0.5, z: 0.5 }, origin)).toEqual(origin);
  });
});

describe('nudgeFieldPos (keyboard a11y per-axis)', () => {
  const pos = { x: 0.5, y: 0.5, z: 0.5 };

  it('shifts one axis by delta, leaving the others untouched', () => {
    expect(nudgeFieldPos(pos, 'x', 0.1)).toEqual({ x: 0.6, y: 0.5, z: 0.5 });
    expect(nudgeFieldPos(pos, 'z', -0.2)).toEqual({ x: 0.5, y: 0.5, z: 0.3 });
  });

  it('clamps into [0,1] and returns a new object', () => {
    expect(nudgeFieldPos({ x: 0.95, y: 0, z: 1 }, 'x', 0.2)).toEqual({ x: 1, y: 0, z: 1 });
    expect(nudgeFieldPos({ x: 0.05, y: 0, z: 0 }, 'x', -0.2)).toEqual({ x: 0, y: 0, z: 0 });
    const out = nudgeFieldPos(pos, 'y', 0.1);
    expect(out).not.toBe(pos);
  });
});
