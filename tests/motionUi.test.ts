import { describe, expect, it } from 'vitest';
import {
  clamp,
  formatClock,
  formatRate,
  timeFraction,
  timeToX,
  xToTime,
} from '../src/components/motion/timelineMath';

describe('timelineMath.clamp', () => {
  it('clamps into [lo, hi]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });
  it('applies hi last on a degenerate inverted range', () => {
    expect(clamp(5, 10, 0)).toBe(0);
  });
});

describe('timelineMath.timeToX / xToTime', () => {
  it('maps t across the width proportionally', () => {
    expect(timeToX(0, 4, 400)).toBe(0);
    expect(timeToX(2, 4, 400)).toBe(200);
    expect(timeToX(4, 4, 400)).toBe(400);
  });

  it('clamps times outside [0, duration] to the ends', () => {
    expect(timeToX(-1, 4, 400)).toBe(0);
    expect(timeToX(9, 4, 400)).toBe(400);
  });

  it('collapses to 0 for a non-positive duration or width (no divide-by-zero)', () => {
    expect(timeToX(2, 0, 400)).toBe(0);
    expect(timeToX(2, -3, 400)).toBe(0);
    expect(timeToX(2, 4, 0)).toBe(0);
  });

  it('xToTime is the inverse of timeToX within the range', () => {
    const duration = 3;
    const width = 600;
    for (const t of [0, 0.4, 1.5, 2.9, 3]) {
      const x = timeToX(t, duration, width);
      expect(xToTime(x, duration, width)).toBeCloseTo(t, 6);
    }
  });

  it('xToTime clamps out-of-range x to the ends and guards zero width', () => {
    expect(xToTime(-50, 4, 400)).toBe(0);
    expect(xToTime(9999, 4, 400)).toBe(4);
    expect(xToTime(200, 4, 0)).toBe(0);
    expect(xToTime(200, 0, 400)).toBe(0);
  });
});

describe('timelineMath.timeFraction', () => {
  it('returns the clamped fraction of duration', () => {
    expect(timeFraction(0, 4)).toBe(0);
    expect(timeFraction(1, 4)).toBe(0.25);
    expect(timeFraction(4, 4)).toBe(1);
    expect(timeFraction(6, 4)).toBe(1);
    expect(timeFraction(-2, 4)).toBe(0);
  });
  it('guards a non-positive duration', () => {
    expect(timeFraction(2, 0)).toBe(0);
  });
});

describe('timelineMath.formatClock', () => {
  it('formats seconds as M:SS.d', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(3.25)).toBe('0:03.2');
    expect(formatClock(9)).toBe('0:09.0');
    expect(formatClock(72.4)).toBe('1:12.4');
    expect(formatClock(600)).toBe('10:00.0');
  });
  it('zero-pads seconds under ten and treats negatives/NaN as zero', () => {
    expect(formatClock(65)).toBe('1:05.0');
    expect(formatClock(-4)).toBe('0:00.0');
    expect(formatClock(Number.NaN)).toBe('0:00.0');
  });
});

describe('timelineMath.formatRate', () => {
  it('renders whole rates without a decimal and fractions trimmed', () => {
    expect(formatRate(1)).toBe('1x');
    expect(formatRate(2)).toBe('2x');
    expect(formatRate(0.5)).toBe('0.5x');
    expect(formatRate(0.25)).toBe('0.25x');
  });
  it('falls back to 1x for non-positive/NaN rates', () => {
    expect(formatRate(0)).toBe('1x');
    expect(formatRate(-2)).toBe('1x');
    expect(formatRate(Number.NaN)).toBe('1x');
  });
});
