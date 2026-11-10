import { describe, expect, it } from 'vitest';
import { sanitizeAppSettings } from '../src/state/appSettings';
import {
  createSpacetimeLinePositions, spacetimeFlowEnabled, spacetimeFocusStrength,
  SPACETIME_QUALITY, SPACETIME_FIELD_DEPTH,
} from '../src/core/shell/fileSpacetime';

describe('GPU Spacetime contours', () => {
  it('defaults to contours and accepts only supported persisted modes', () => {
    expect(sanitizeAppSettings().fileSpacetimeMode).toBe('contours');
    expect(sanitizeAppSettings({ fileSpacetimeMode: 'off' }).fileSpacetimeMode).toBe('off');
    expect(sanitizeAppSettings({ fileSpacetimeMode: 'flow' }).fileSpacetimeMode).toBe('flow');
    expect(sanitizeAppSettings({ fileSpacetimeMode: 'bogus' as 'flow' }).fileSpacetimeMode).toBe('contours');
    expect(sanitizeAppSettings({ fileSpacetimeMode: 'flow', fileFxMode: 'balanced' }).fileFxMode)
      .toBe('balanced');
  });

  it('builds a fixed bounded GPU line buffer once, not file or history data', () => {
    for (const mode of ['balanced', 'cinematic'] as const) {
      const budget = SPACETIME_QUALITY[mode];
      const points = createSpacetimeLinePositions(budget);
      expect(points.length).toBe((budget.horizontal + budget.vertical) * budget.segments * 6);
      expect(points.length).toBeLessThanOrEqual(60000);
      expect(points.every(Number.isFinite)).toBe(true);
      for (let k = 2; k < points.length; k += 3) {
        expect(points[k]).toBe(SPACETIME_FIELD_DEPTH);
      }
      expect(budget.opacity).toBeLessThan(0.20);
    }
    expect(createSpacetimeLinePositions(SPACETIME_QUALITY.off)).toHaveLength(0);
    expect(createSpacetimeLinePositions(SPACETIME_QUALITY.cinematic))
      .toEqual(createSpacetimeLinePositions(SPACETIME_QUALITY.cinematic));
  });

  it('disables timeline flow when paused, reduced-motion, or GPU-degraded', () => {
    expect(spacetimeFlowEnabled('flow', true, true, false, false)).toBe(true);
    expect(spacetimeFlowEnabled('contours', true, true, false, false)).toBe(false);
    expect(spacetimeFlowEnabled('off', true, true, false, false)).toBe(false);
    expect(spacetimeFlowEnabled('flow', false, true, false, false)).toBe(false);
    expect(spacetimeFlowEnabled('flow', true, false, false, false)).toBe(false);
    expect(spacetimeFlowEnabled('flow', true, true, true, false)).toBe(false);
    expect(spacetimeFlowEnabled('flow', true, true, false, true)).toBe(false);
  });

  it('keeps selection wells subtle and always in bounds', () => {
    expect(spacetimeFocusStrength(false, 'focus', 18)).toBe(0);
    expect(spacetimeFocusStrength(true, 'off', 0)).toBeCloseTo(0.45);
    expect(spacetimeFocusStrength(true, 'links', 0)).toBeCloseTo(0.56);
    expect(spacetimeFocusStrength(true, 'focus', 18)).toBeLessThanOrEqual(0.95);
    expect(spacetimeFocusStrength(true, 'focus', 18)).toBeGreaterThan(
      spacetimeFocusStrength(true, 'links', 0));
    expect(spacetimeFocusStrength(true, 'links', Number.NaN)).toBeCloseTo(0.56);
  });

  it('bounds malformed geometry configurations without unbounded CPU or GPU buffers', () => {
    const positions = createSpacetimeLinePositions({
      horizontal: Number.POSITIVE_INFINITY, vertical: 99999,
      segments: 99999, opacity: 1,
    });
    expect(positions.length).toBeLessThanOrEqual((24 + 32) * 96 * 6);
    expect(positions.every(Number.isFinite)).toBe(true);
  });
});
