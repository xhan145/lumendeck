import { describe, it, expect } from 'vitest';
import type { ConstellationNode } from '../src/components/constellation/types';
import {
  canGoBack,
  findNode,
  goBack,
  indexConstellation,
  indexParents,
  initialSelection,
  selectNode,
} from '../src/components/constellation/selection';
import {
  ORBIT_MAX_INCLINATION,
  hashString,
  orbitParamsFor,
  orbitPosition,
} from '../src/components/constellation/orbits';

const tree: ConstellationNode = {
  id: 'lumen',
  label: 'LumenDeck',
  colors: ['#34D6F4', '#7C3AED'],
  type: 'core',
  children: [
    {
      id: 'studio',
      label: 'Studio',
      colors: ['#34D6F4', '#7C3AED'],
      children: [
        { id: 'sampler', label: 'Sampler', colors: ['#fff', '#000'] },
        { id: 'canvas', label: 'Canvas', colors: ['#fff', '#000'], children: [] },
      ],
    },
    { id: 'motion', label: 'Motion Engine', colors: ['#fff', '#000'] },
  ],
};

describe('indexConstellation / findNode', () => {
  it('indexes every node recursively', () => {
    const map = indexConstellation(tree);
    expect(map.size).toBe(5);
    expect(map.get('sampler')?.label).toBe('Sampler');
  });

  it('findNode resolves deep nodes and misses safely', () => {
    expect(findNode(tree, 'canvas')?.id).toBe('canvas');
    expect(findNode(tree, 'nope')).toBeNull();
  });

  it('indexParents maps every child to its parent (root excluded)', () => {
    const parents = indexParents(tree);
    expect(parents.get('sampler')).toBe('studio');
    expect(parents.get('studio')).toBe('lumen');
    expect(parents.has('lumen')).toBe(false);
  });
});

describe('selection history', () => {
  const index = indexConstellation(tree);

  it('selecting a node pushes the previous center; back pops it', () => {
    let s = initialSelection('lumen');
    s = selectNode(s, 'studio', index);
    s = selectNode(s, 'sampler', index);
    expect(s.currentId).toBe('sampler');
    expect(s.history).toEqual(['lumen', 'studio']);
    s = goBack(s);
    expect(s.currentId).toBe('studio');
    s = goBack(s);
    expect(s.currentId).toBe('lumen');
    expect(canGoBack(s)).toBe(false);
  });

  it('selecting the current node never duplicates history (same reference)', () => {
    const s0 = selectNode(initialSelection('lumen'), 'studio', index);
    const s1 = selectNode(s0, 'studio', index);
    expect(s1).toBe(s0);
  });

  it('selecting an unknown id is a safe no-op', () => {
    const s0 = initialSelection('lumen');
    expect(selectNode(s0, 'ghost-node', index)).toBe(s0);
  });

  it('back at the root is a safe no-op', () => {
    const s0 = initialSelection('lumen');
    expect(goBack(s0)).toBe(s0);
    expect(canGoBack(s0)).toBe(false);
  });

  it('selection works for non-direct descendants (normalized map, not parent walk)', () => {
    let s = initialSelection('lumen');
    s = selectNode(s, 'sampler', index); // skip the intermediate level entirely
    expect(s.currentId).toBe('sampler');
    expect(s.history).toEqual(['lumen']);
  });
});

describe('deterministic orbits', () => {
  it('hashString is stable and 32-bit', () => {
    expect(hashString('lumen')).toBe(hashString('lumen'));
    expect(hashString('lumen')).not.toBe(hashString('lumen2'));
    expect(hashString('x')).toBeGreaterThanOrEqual(0);
  });

  it('same inputs always produce identical params', () => {
    const a = orbitParamsFor(2, 6, 'studio', 0.7);
    const b = orbitParamsFor(2, 6, 'studio', 0.7);
    expect(a).toEqual(b);
  });

  it('sibling radii step outward and stay distinct', () => {
    const params = Array.from({ length: 6 }, (_, i) => orbitParamsFor(i, 6, `n${i}`));
    for (let i = 1; i < params.length; i++) {
      expect(params[i].radius).toBeGreaterThan(params[i - 1].radius);
    }
  });

  it('inclinations stay inside the legibility band', () => {
    for (let i = 0; i < 12; i++) {
      const p = orbitParamsFor(i, 12, `node-${i}`);
      expect(Math.abs(p.inclination)).toBeLessThanOrEqual(ORBIT_MAX_INCLINATION);
    }
  });

  it('outer orbits are slower (Kepler-ish), all speeds positive', () => {
    const inner = orbitParamsFor(0, 5, 'a');
    const outer = orbitParamsFor(4, 5, 'b');
    expect(outer.speed).toBeLessThan(inner.speed);
    expect(outer.speed).toBeGreaterThan(0);
  });

  it('orbitPosition preserves the radius at any time (rotations are isometries)', () => {
    const p = orbitParamsFor(3, 7, 'motion', 0.4);
    for (const t of [0, 1.5, 42.42, 1000]) {
      const v = orbitPosition(p, t);
      const r = Math.hypot(v.x, v.y, v.z);
      expect(r).toBeCloseTo(p.radius, 10);
    }
  });

  it('orbitPosition writes into the provided out-vector without allocating', () => {
    const p = orbitParamsFor(0, 1, 'reuse');
    const out = { x: 0, y: 0, z: 0 };
    const v = orbitPosition(p, 2, out);
    expect(v).toBe(out);
  });

  it('strength boosts scale', () => {
    const weak = orbitParamsFor(1, 4, 'same-id', 0);
    const strong = orbitParamsFor(1, 4, 'same-id', 1);
    expect(strong.scale).toBeGreaterThan(weak.scale);
  });
});
