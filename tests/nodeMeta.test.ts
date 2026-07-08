import { describe, it, expect } from 'vitest';
import {
  touchNode,
  seedNodeMeta,
  emissiveFor,
  hydrateNodeMeta,
  LUMINOSITY_HALF_LIFE_MS,
} from '../src/state/nodeMeta';

describe('touchNode', () => {
  it('creates an entry on first touch (createdAt == lastActiveAt)', () => {
    const m = touchNode({}, 'a', 1000);
    expect(m.a).toEqual({ createdAt: 1000, lastActiveAt: 1000 });
  });

  it('keeps createdAt but advances lastActiveAt on re-touch', () => {
    const m = touchNode(touchNode({}, 'a', 1000), 'a', 5000);
    expect(m.a).toEqual({ createdAt: 1000, lastActiveAt: 5000 });
  });

  it('does not mutate the input map', () => {
    const before = touchNode({}, 'a', 1000);
    touchNode(before, 'a', 2000);
    expect(before.a.lastActiveAt).toBe(1000);
  });
});

describe('seedNodeMeta', () => {
  it('adds missing node ids and leaves existing ones untouched', () => {
    const base = touchNode({}, 'a', 1000);
    const seeded = seedNodeMeta(base, ['a', 'b'], 9000);
    expect(seeded.a).toEqual({ createdAt: 1000, lastActiveAt: 1000 }); // unchanged
    expect(seeded.b).toEqual({ createdAt: 9000, lastActiveAt: 9000 }); // seeded
  });

  it('returns the SAME reference when nothing is missing', () => {
    const base = touchNode({}, 'a', 1000);
    expect(seedNodeMeta(base, ['a'], 9000)).toBe(base);
  });
});

describe('emissiveFor (half-life decay)', () => {
  it('is 1 at the moment of activity and 0 for unknown nodes', () => {
    expect(emissiveFor({ createdAt: 0, lastActiveAt: 1000 }, 1000)).toBe(1);
    expect(emissiveFor(undefined, 1000)).toBe(0);
  });

  it('halves each half-life', () => {
    const meta = { createdAt: 0, lastActiveAt: 0 };
    expect(emissiveFor(meta, LUMINOSITY_HALF_LIFE_MS)).toBeCloseTo(0.5, 5);
    expect(emissiveFor(meta, 2 * LUMINOSITY_HALF_LIFE_MS)).toBeCloseTo(0.25, 5);
  });

  it('decays toward 0 for long-idle nodes', () => {
    expect(emissiveFor({ createdAt: 0, lastActiveAt: 0 }, 10 * LUMINOSITY_HALF_LIFE_MS)).toBeLessThan(0.01);
  });
});

describe('hydrateNodeMeta', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const out = hydrateNodeMeta({
      a: { createdAt: 1, lastActiveAt: 2 },
      b: { createdAt: 5 }, // lastActiveAt falls back to createdAt
      c: { nope: true }, // dropped
      d: 'garbage', // dropped
    });
    expect(out.a).toEqual({ createdAt: 1, lastActiveAt: 2 });
    expect(out.b).toEqual({ createdAt: 5, lastActiveAt: 5 });
    expect(out.c).toBeUndefined();
    expect(out.d).toBeUndefined();
  });

  it('returns {} for non-objects', () => {
    expect(hydrateNodeMeta(null)).toEqual({});
    expect(hydrateNodeMeta(42)).toEqual({});
  });
});
