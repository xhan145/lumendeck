import { describe, it, expect } from 'vitest';
import type { BufferAttribute } from 'three';
import {
  buildGravityGrid,
  sampleGravityGrid,
  createParticleField,
  GRAVITY_GRID_N,
} from '../src/components/graph/graph3d/particles';

const well = (x: number, z: number) => ({ x, z, depth: 150, sigma: 200 });

describe('buildGravityGrid + sampleGravityGrid', () => {
  it('height peaks at the well and the gradient points toward it', () => {
    const grid = buildGravityGrid([well(0, 0)], GRAVITY_GRID_N, 4000);
    const center = sampleGravityGrid(grid, GRAVITY_GRID_N, 4000, 0, 0);
    const right = sampleGravityGrid(grid, GRAVITY_GRID_N, 4000, 400, 0);
    expect(center.h).toBeGreaterThan(right.h); // mass sits at the well
    expect(right.gx).toBeLessThan(0); // at +x, gradient pulls in -x (toward the well)
    expect(Math.abs(center.gx)).toBeLessThan(Math.abs(right.gx)); // ~flat at the centre
  });

  it('superposes two wells (a point between them is pulled both ways → near-balanced)', () => {
    const grid = buildGravityGrid([well(-500, 0), well(500, 0)], GRAVITY_GRID_N, 4000);
    const mid = sampleGravityGrid(grid, GRAVITY_GRID_N, 4000, 0, 0);
    expect(Math.abs(mid.gx)).toBeLessThan(0.05); // symmetric pull cancels at the midpoint
  });
});

describe('gravity integration (particles fall toward mass)', () => {
  it('a particle offset from a central well accelerates toward it', () => {
    const grid = buildGravityGrid([well(0, 0)], GRAVITY_GRID_N, 4000);
    let px = 800;
    let vx = 0;
    for (let step = 0; step < 80; step++) {
      const s = sampleGravityGrid(grid, GRAVITY_GRID_N, 4000, px, 0);
      vx = (vx + s.gx * 620 * 0.016) * 0.94; // mirrors ParticleField.advance
      px += vx * 0.016;
    }
    expect(vx).toBeLessThan(0); // moving toward the well (−x)
    expect(px).toBeLessThan(800); // net displacement toward the well
  });
});

describe('createParticleField', () => {
  it('builds a Points cloud of `count` vertices', () => {
    const f = createParticleField(500, 4000, '#34D6F4');
    expect(f.points.geometry.getAttribute('position').count).toBe(500);
    f.dispose();
  });

  it('advance writes finite positions and flags the buffer for upload', () => {
    const f = createParticleField(300, 4000, '#34D6F4');
    f.setWells([well(0, 0)]);
    const attr = f.points.geometry.getAttribute('position') as BufferAttribute;
    const v0 = attr.version;
    f.advance(0.016);
    const pos = attr.array as Float32Array;
    expect(pos.every((v) => Number.isFinite(v))).toBe(true);
    expect(attr.version).toBeGreaterThan(v0); // needsUpdate=true bumped the version (upload queued)
    f.dispose();
  });

  it('dispose is idempotent', () => {
    const f = createParticleField(50, 4000, '#34D6F4');
    expect(() => {
      f.dispose();
      f.dispose();
    }).not.toThrow();
  });
});
