import { describe, it, expect } from 'vitest';
import {
  nodeDepth,
  massFromHeight,
  MASS_REFERENCE_Y,
  MASS_DEADBAND,
  MASS_MIN,
  MASS_MAX,
} from '../src/components/graph/graph3d/nodeSpace';
import { zFromNode } from '../src/components/graph/graph3d/projection';

describe('nodeDepth', () => {
  it('uses the explicit z when set (free 3rd-axis placement)', () => {
    expect(nodeDepth({ x: 100, z: 42 })).toBe(42);
    expect(nodeDepth({ x: 100, z: -300 })).toBe(-300);
    expect(nodeDepth({ x: 100, z: 0 })).toBe(0); // 0 is a real depth, not "unset"
  });

  it('falls back to the legacy column rule when z is unset/invalid (old saves)', () => {
    expect(nodeDepth({ x: 100 })).toBe(zFromNode(100));
    expect(nodeDepth({ x: 250, z: undefined })).toBe(zFromNode(250));
    expect(nodeDepth({ x: 250, z: Number.NaN })).toBe(zFromNode(250));
  });
});

describe('massFromHeight', () => {
  it('is exactly neutral (×1) at the reference and within the deadband', () => {
    expect(massFromHeight(MASS_REFERENCE_Y)).toBe(1);
    expect(massFromHeight(MASS_REFERENCE_Y + MASS_DEADBAND)).toBe(1);
    expect(massFromHeight(MASS_REFERENCE_Y - MASS_DEADBAND)).toBe(1);
    expect(massFromHeight(MASS_REFERENCE_Y + MASS_DEADBAND * 0.5)).toBe(1);
  });

  it('grows above the deadband and shrinks below it', () => {
    expect(massFromHeight(MASS_DEADBAND + 300)).toBeGreaterThan(1);
    expect(massFromHeight(-(MASS_DEADBAND + 300))).toBeLessThan(1);
  });

  it('is monotonic non-decreasing in height', () => {
    let prev = -Infinity;
    for (let y = -1200; y <= 1200; y += 100) {
      const m = massFromHeight(y);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('clamps at the extremes', () => {
    expect(massFromHeight(1e6)).toBe(MASS_MAX);
    expect(massFromHeight(-1e6)).toBe(MASS_MIN);
  });

  it('treats non-finite height as neutral', () => {
    expect(massFromHeight(Number.NaN)).toBe(1);
    expect(massFromHeight(Infinity)).toBe(1);
  });
});
