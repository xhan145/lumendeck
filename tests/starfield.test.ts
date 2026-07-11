import { describe, it, expect } from 'vitest';
import {
  createStarfield,
  stepStarfield,
  buildChain,
  splashPhase,
  STARFIELD_MAX_DT,
  SPLASH_TOTAL_MS,
  type StarfieldState,
} from '../src/ui/starfield/engine';

const make = (over?: Partial<Parameters<typeof createStarfield>[0]>) =>
  createStarfield({ seed: 42, starCount: 60, dustCount: 12, ...over });

/** Advance by `seconds` in fixed 16ms steps. */
const run = (s: StarfieldState, seconds: number) => {
  const steps = Math.round(seconds / 0.016);
  for (let i = 0; i < steps; i++) stepStarfield(s, 0.016);
  return s;
};

describe('createStarfield', () => {
  it('is deterministic: same seed ⇒ identical fields after many steps', () => {
    const a = run(make(), 5);
    const b = run(make(), 5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds diverge', () => {
    const a = make({ seed: 1 });
    const b = make({ seed: 2 });
    expect(JSON.stringify(a.stars)).not.toBe(JSON.stringify(b.stars));
  });

  it('populates the requested counts with sane fields', () => {
    const s = make();
    expect(s.stars).toHaveLength(60);
    expect(s.dust).toHaveLength(12);
    for (const star of s.stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(1);
      expect(star.size).toBeGreaterThan(0);
      expect(star.color.startsWith('#')).toBe(true);
    }
  });
});

describe('stepStarfield', () => {
  it('keeps every position wrapped in [0,1] over a long run', () => {
    const s = run(make(), 30);
    for (const star of s.stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(1);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(1);
    }
    for (const p of s.dust) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('clamps huge deltas (tab restore) to STARFIELD_MAX_DT', () => {
    const a = make();
    const b = make();
    stepStarfield(a, 60); // one "minute" frame
    stepStarfield(b, STARFIELD_MAX_DT);
    expect(a.time).toBeCloseTo(b.time, 9);
  });

  it('ignores garbage deltas', () => {
    const s = make();
    stepStarfield(s, Number.NaN);
    stepStarfield(s, -5);
    expect(s.time).toBe(0);
  });

  it('cycles a constellation through drawing → holding → fading → cooldown', () => {
    const s = make();
    run(s, 4); // past the initial spawn delay
    expect(s.constellation).not.toBeNull();
    // Drive to completion of the draw.
    run(s, 2);
    expect(s.constellation?.stage === 'holding' || s.constellation?.stage === 'fading').toBe(true);
    // Hold + fade fully → cleared with a cooldown armed.
    run(s, 7);
    if (s.constellation === null) {
      expect(s.constellationIn).toBeGreaterThan(0);
    } else {
      // A new one may already be mid-cycle after respawn — also valid.
      expect(['drawing', 'holding', 'fading']).toContain(s.constellation.stage);
    }
  });

  it('constellations can be disabled', () => {
    const s = make({ constellations: false });
    run(s, 20);
    expect(s.constellation).toBeNull();
  });

  it('shooting star lives a bounded life then re-arms', () => {
    const s = make();
    let sawActive = false;
    for (let i = 0; i < 60 / 0.016 && !sawActive; i++) {
      stepStarfield(s, 0.016);
      if (s.shooting.active) sawActive = true;
    }
    expect(sawActive).toBe(true);
    // Once active it must deactivate within maxLife + margin.
    let steps = 0;
    while (s.shooting.active && steps < 200) {
      stepStarfield(s, 0.016);
      steps++;
    }
    expect(s.shooting.active).toBe(false);
    expect(s.shootingIn).toBeGreaterThan(0);
  });
});

describe('buildChain', () => {
  it('builds a chain of unique nearest-neighbor star indices', () => {
    const s = make();
    const chain = buildChain(s.stars, 0, 5);
    expect(chain).toHaveLength(5);
    expect(new Set(chain).size).toBe(5);
    expect(chain[0]).toBe(0);
  });

  it('caps at the available star count', () => {
    const s = createStarfield({ seed: 7, starCount: 3, dustCount: 0 });
    expect(buildChain(s.stars, 0, 10)).toHaveLength(3);
  });
});

describe('splashPhase', () => {
  it('starts dark and ends done with everything resolved', () => {
    const start = splashPhase(0);
    expect(start.starsAlpha).toBe(0);
    expect(start.wordmarkAlpha).toBe(0);
    expect(start.done).toBe(false);
    const end = splashPhase(SPLASH_TOTAL_MS);
    expect(end.starsAlpha).toBe(1);
    expect(end.linesProgress).toBe(1);
    expect(end.wordmarkAlpha).toBe(1);
    expect(end.liftT).toBe(1);
    expect(end.done).toBe(true);
  });

  it('every channel is monotonic non-decreasing and in [0,1]', () => {
    let prev = splashPhase(0);
    for (let t = 0; t <= SPLASH_TOTAL_MS + 200; t += 25) {
      const p = splashPhase(t);
      for (const k of ['starsAlpha', 'linesProgress', 'wordmarkAlpha', 'liftT'] as const) {
        expect(p[k]).toBeGreaterThanOrEqual(prev[k]);
        expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(p[k]).toBeLessThanOrEqual(1);
      }
      prev = p;
    }
  });

  it('choreography order: stars → lines → wordmark → lift', () => {
    const mid = splashPhase(1000);
    expect(mid.starsAlpha).toBe(1);
    expect(mid.linesProgress).toBeGreaterThan(0);
    expect(mid.wordmarkAlpha).toBe(0);
    expect(mid.liftT).toBe(0);
  });

  it('handles garbage input as t=0', () => {
    expect(splashPhase(Number.NaN).done).toBe(false);
    expect(splashPhase(-100).starsAlpha).toBe(0);
  });
});
