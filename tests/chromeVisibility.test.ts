import { describe, it, expect } from 'vitest';
import { chromeVisible, CHROME_IDLE_MS, EDGE_PROXIMITY_PX } from '../src/ui/chrome/chromeVisibility';

const base = {
  pinned: false,
  hovering: false,
  focusWithin: false,
  nearEdge: false,
  msSinceActivity: 0,
  idleMs: CHROME_IDLE_MS,
};

describe('chromeVisible', () => {
  it('pinned bars never hide, regardless of idle time', () => {
    expect(chromeVisible({ ...base, pinned: true, msSinceActivity: 1e9 })).toBe(true);
  });

  it('hovering keeps the bar visible past the idle window', () => {
    expect(chromeVisible({ ...base, hovering: true, msSinceActivity: 1e9 })).toBe(true);
  });

  it('keyboard focus inside the bar blocks hiding (never hide mid-interaction)', () => {
    expect(chromeVisible({ ...base, focusWithin: true, msSinceActivity: 1e9 })).toBe(true);
  });

  it('pointer near the edge reveals the bar', () => {
    expect(chromeVisible({ ...base, nearEdge: true, msSinceActivity: 1e9 })).toBe(true);
  });

  it('visible during the idle grace, hidden after it expires', () => {
    expect(chromeVisible({ ...base, msSinceActivity: CHROME_IDLE_MS - 1 })).toBe(true);
    expect(chromeVisible({ ...base, msSinceActivity: CHROME_IDLE_MS })).toBe(false);
    expect(chromeVisible({ ...base, msSinceActivity: CHROME_IDLE_MS + 1 })).toBe(false);
  });

  it('exports a sane proximity threshold', () => {
    expect(EDGE_PROXIMITY_PX).toBeGreaterThan(0);
    expect(EDGE_PROXIMITY_PX).toBeLessThan(100);
  });
});
