import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createMistShell,
  createMistSmoke,
  graphEmission,
  universeEmission,
  type MistEmitter,
} from '../src/components/graph/graph3d/mist';
import type { FlowContext } from '../src/components/graph/graph3d/flowField';

const EMPTY: FlowContext = { bodies: [], pulses: [], eddy: null };

describe('universeEmission (status → mist profile)', () => {
  it('forming nodes are shrouded, complete nodes are clear', () => {
    const forming = universeEmission('forming');
    const complete = universeEmission('complete');
    expect(forming.shellDensity).toBeGreaterThan(0.7);
    expect(complete.shellDensity).toBe(0);
    expect(forming.wispRate).toBeGreaterThan(complete.wispRate);
  });

  it('dormant haze is thin and near-static; active wisps churn faster', () => {
    const dormant = universeEmission('dormant');
    const active = universeEmission('active');
    expect(dormant.shellDensity).toBeLessThan(0.5);
    expect(dormant.churn).toBeLessThan(0.1);
    expect(active.churn).toBeGreaterThan(dormant.churn);
    expect(active.shellDensity).toBeLessThan(dormant.shellDensity);
  });

  it('strength scales emission (±30% band)', () => {
    const weak = universeEmission('forming', 0);
    const strong = universeEmission('forming', 1);
    expect(strong.wispRate).toBeGreaterThan(weak.wispRate);
    expect(strong.wispRate / weak.wispRate).toBeCloseTo(1.3 / 0.7, 5);
  });
});

describe('graphEmission (activity recency → steam, luminosity half-life)', () => {
  const HL = 45_000;

  it('full steam at the moment of activity, half at one half-life, ~0 long after', () => {
    expect(graphEmission(1000, 1000, HL)).toBe(1);
    expect(graphEmission(1000, 1000 + HL, HL)).toBeCloseTo(0.5, 5);
    expect(graphEmission(1000, 1000 + 10 * HL, HL)).toBeLessThan(0.002);
  });

  it('cold/never-touched nodes emit nothing', () => {
    expect(graphEmission(0, 5000, HL)).toBe(0);
    expect(graphEmission(Number.NaN, 5000, HL)).toBe(0);
  });
});

describe('createMistSmoke', () => {
  const emitter: MistEmitter = { x: 0, y: 0, z: 0, radius: 2, rate: 10, color: new THREE.Color('#34d6f4') };

  it('builds one Points layer with normal blending and no depth writes', () => {
    const smoke = createMistSmoke(64);
    const mat = smoke.points.material as THREE.ShaderMaterial;
    expect(mat.glslVersion).toBe(THREE.GLSL3);
    expect(mat.blending).toBe(THREE.NormalBlending); // smoke, not glow
    expect(mat.depthWrite).toBe(false);
    expect(mat.transparent).toBe(true);
    expect(smoke.points.geometry.getAttribute('position').count).toBe(64);
    smoke.dispose();
  });

  it('spawns from emitters at the configured rate and advects finitely', () => {
    const smoke = createMistSmoke(128);
    expect(smoke.alive()).toBe(0);
    // 1 simulated second at rate 10 → ~10 wisps.
    for (let step = 0; step < 10; step++) smoke.advance(0.1, step * 0.1, 0, EMPTY, [emitter]);
    expect(smoke.alive()).toBeGreaterThanOrEqual(9);
    expect(smoke.alive()).toBeLessThanOrEqual(11);
    const pos = smoke.points.geometry.getAttribute('position').array as Float32Array;
    expect(pos.every((v) => Number.isFinite(v))).toBe(true);
    smoke.dispose();
  });

  it('wisps die after their lifetime and slots recycle (bounded population)', () => {
    const smoke = createMistSmoke(32);
    for (let step = 0; step < 20; step++) smoke.advance(0.5, step * 0.5, 0, EMPTY, [emitter]); // 10s ≫ lifetime
    expect(smoke.alive()).toBeLessThanOrEqual(32); // never exceeds the pool
    smoke.dispose();
  });

  it('dt=0 (reduced motion) spawns nothing and moves nothing', () => {
    const smoke = createMistSmoke(32);
    smoke.advance(0.2, 0.2, 0, EMPTY, [emitter]); // seed a couple of wisps
    const before = [...(smoke.points.geometry.getAttribute('position').array as Float32Array)];
    const aliveBefore = smoke.alive();
    smoke.advance(0, 5, 0, EMPTY, [emitter]); // frozen time step
    const after = smoke.points.geometry.getAttribute('position').array as Float32Array;
    expect([...after]).toEqual(before);
    expect(smoke.alive()).toBe(aliveBefore);
    smoke.dispose();
  });

  it('is deterministic (no Math.random): two instances evolve identically', () => {
    const a = createMistSmoke(64);
    const b = createMistSmoke(64);
    for (let step = 0; step < 8; step++) {
      a.advance(0.15, step * 0.15, 0, EMPTY, [emitter]);
      b.advance(0.15, step * 0.15, 0, EMPTY, [emitter]);
    }
    const pa = [...(a.points.geometry.getAttribute('position').array as Float32Array)];
    const pb = [...(b.points.geometry.getAttribute('position').array as Float32Array)];
    expect(pa).toEqual(pb);
    a.dispose();
    b.dispose();
  });
});

describe('createMistShell', () => {
  it('is a normal-blended, depth-read-only billboard with data-driven uniforms', () => {
    const shell = createMistShell(1.6, '#34d6f4', '#a78bfa', universeEmission('forming'));
    const mat = shell.mesh.material as THREE.ShaderMaterial;
    expect(mat.glslVersion).toBe(THREE.GLSL3);
    expect(mat.blending).toBe(THREE.NormalBlending);
    expect(mat.depthWrite).toBe(false);
    expect(mat.transparent).toBe(true);
    expect(mat.uniforms.uDensity.value).toBeCloseTo(0.85);
    shell.setProfile(universeEmission('complete'));
    expect(mat.uniforms.uDensity.value).toBe(0);
    shell.setTime(12.5);
    expect(mat.uniforms.uTime.value).toBe(12.5);
    shell.dispose();
  });

  it('dispose is idempotent', () => {
    const shell = createMistShell(1, '#fff', '#000', universeEmission('active'));
    expect(() => {
      shell.dispose();
      shell.dispose();
    }).not.toThrow();
  });
});
