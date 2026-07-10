import { describe, it, expect } from 'vitest';
import {
  LEVEL_ORDER,
  levelRank,
  minLevel,
  featuresFor,
  motionPolicy,
  clampDelta,
  MAX_DELTA_S,
  createAdaptiveQuality,
} from '../src/components/graph/graph3d/quality';

describe('level ordering', () => {
  it('orders cheap → expensive and min picks the cheaper', () => {
    expect(LEVEL_ORDER).toEqual(['off', 'minimal', 'standard', 'rich', 'cinematic']);
    expect(levelRank('off')).toBe(0);
    expect(minLevel('cinematic', 'standard')).toBe('standard');
    expect(minLevel('minimal', 'rich')).toBe('minimal');
    expect(minLevel('off', 'cinematic')).toBe('off');
  });
});

describe('featuresFor (tier table)', () => {
  it('off renders nothing', () => {
    const f = featuresFor('off');
    expect(f.fabricTier).toBeNull();
    expect(f.particleCount).toBe(0);
    expect(f.pulsesPerEdge).toBe(0);
    expect(f.bloom).toBe(false);
    expect(f.starfield).toBe(0);
    expect(f.fabricWaveAmp).toBe(0);
  });

  it('minimal is fabric-only (the cheap floor for weak machines)', () => {
    const f = featuresFor('minimal');
    expect(f.fabricTier).toBe('minimal');
    expect(f.particleCount).toBe(0);
    expect(f.pulsesPerEdge).toBe(0);
    expect(f.bloom).toBe(false);
  });

  it('feature budgets grow monotonically with the tier', () => {
    const levels = ['minimal', 'standard', 'rich', 'cinematic'] as const;
    for (let i = 1; i < levels.length; i++) {
      const lo = featuresFor(levels[i - 1]);
      const hi = featuresFor(levels[i]);
      expect(hi.particleCount).toBeGreaterThanOrEqual(lo.particleCount);
      expect(hi.pulsesPerEdge).toBeGreaterThanOrEqual(lo.pulsesPerEdge);
      expect(hi.starfield).toBeGreaterThanOrEqual(lo.starfield);
      expect(hi.fabricWaveAmp).toBeGreaterThanOrEqual(lo.fabricWaveAmp);
    }
  });

  it('bloom is cinematic-only', () => {
    expect(featuresFor('standard').bloom).toBe(false);
    expect(featuresFor('rich').bloom).toBe(false);
    expect(featuresFor('cinematic').bloom).toBe(true);
    expect(featuresFor('cinematic').bloomStrength).toBeGreaterThan(0);
  });
});

describe('motionPolicy (reduced motion)', () => {
  it('reduced motion silences every animated ambient layer', () => {
    const p = motionPolicy(true);
    expect(p.particles).toBe(false);
    expect(p.pulses).toBe(false);
    expect(p.ripples).toBe(false);
    expect(p.fabricWaves).toBe(false);
  });

  it('normal motion allows them all', () => {
    const p = motionPolicy(false);
    expect(p.particles).toBe(true);
    expect(p.pulses).toBe(true);
    expect(p.ripples).toBe(true);
    expect(p.fabricWaves).toBe(true);
  });
});

describe('clampDelta', () => {
  it('passes small deltas, clamps huge ones, zeroes garbage', () => {
    expect(clampDelta(0.016)).toBe(0.016);
    expect(clampDelta(5)).toBe(MAX_DELTA_S);
    expect(clampDelta(-1)).toBe(0);
    expect(clampDelta(Number.NaN)).toBe(0);
  });
});

describe('createAdaptiveQuality', () => {
  const OPTS = { budgetMs: 25, holdMs: 2000, recoverMs: 10000, maxSampleMs: 250 };

  /** Feed steady frames of `ms` from t0 for `duration` ms; returns end time. */
  const feed = (q: ReturnType<typeof createAdaptiveQuality>, ms: number, t0: number, duration: number) => {
    let t = t0;
    while (t < t0 + duration) {
      q.feed(ms, t);
      t += ms;
    }
    return t;
  };

  it('starts fully open (cinematic cap)', () => {
    const q = createAdaptiveQuality(OPTS);
    expect(q.cap()).toBe('cinematic');
    expect(q.effective('rich')).toBe('rich');
  });

  it('downgrades ONE step after sustained over-budget frames', () => {
    const q = createAdaptiveQuality(OPTS);
    feed(q, 40, 0, 3000); // 40ms frames, 3s > holdMs
    expect(q.cap()).toBe('rich');
    expect(q.effective('cinematic')).toBe('rich');
  });

  it('a brief spike does NOT downgrade (hysteresis)', () => {
    const q = createAdaptiveQuality(OPTS);
    let t = feed(q, 16, 0, 1000); // healthy
    t = feed(q, 40, t, 500); // spike shorter than holdMs
    feed(q, 16, t, 1000); // healthy again — EMA recovers, window resets
    expect(q.cap()).toBe('cinematic');
  });

  it('keeps stepping down under continued load, but never below the floor', () => {
    const q = createAdaptiveQuality({ ...OPTS, floor: 'minimal' });
    feed(q, 60, 0, 30000);
    expect(q.cap()).toBe('minimal');
  });

  it('recovers slowly: one step only after a long comfortable stretch', () => {
    const q = createAdaptiveQuality(OPTS);
    let t = feed(q, 40, 0, 3000); // → rich
    expect(q.cap()).toBe('rich');
    t = feed(q, 10, t, 5000); // fast but shorter than recoverMs → no change yet
    expect(q.cap()).toBe('rich');
    feed(q, 10, t, 8000); // now past recoverMs → ONE step back
    expect(q.cap()).toBe('cinematic');
  });

  it('does not oscillate: recovery re-arms the full window per step', () => {
    const q = createAdaptiveQuality(OPTS);
    let t = feed(q, 60, 0, 3000);
    t = feed(q, 60, t, 3000);
    expect(q.cap()).toBe('standard'); // two downgrades
    t = feed(q, 10, t, 11000); // one recovery window
    expect(q.cap()).toBe('rich'); // exactly ONE step back, not a jump to the top
  });

  it('ignores idle gaps (dirty-flag sleeps are not slow frames)', () => {
    const q = createAdaptiveQuality(OPTS);
    let t = 0;
    for (let i = 0; i < 100; i++) {
      q.feed(3000, t); // 3s between one-off idle flushes
      t += 3000;
    }
    expect(q.cap()).toBe('cinematic');
  });
});
