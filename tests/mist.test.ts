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
    // 1 simulated second (dt within the internal clamp) at rate 10 → ~10 wisps.
    for (let step = 0; step < 20; step++) smoke.advance(0.05, step * 0.05, 0, EMPTY, [emitter]);
    expect(smoke.alive()).toBeGreaterThanOrEqual(9);
    expect(smoke.alive()).toBeLessThanOrEqual(11);
    const pos = smoke.points.geometry.getAttribute('position').array as Float32Array;
    expect(pos.every((v) => Number.isFinite(v))).toBe(true);
    smoke.dispose();
  });

  it('wisps die after their lifetime and slots recycle (bounded population)', () => {
    const smoke = createMistSmoke(32);
    for (let step = 0; step < 170; step++) smoke.advance(0.05, step * 0.05, 0, EMPTY, [emitter]); // 8.5s ≫ lifetime
    expect(smoke.alive()).toBeLessThanOrEqual(32); // never exceeds the pool
    expect(smoke.alive()).toBeGreaterThan(0); // recycled slots keep emitting
    smoke.dispose();
  });

  it('clamps a huge dt like every animated layer (restored tab must not fling wisps)', () => {
    const a = createMistSmoke(64);
    const b = createMistSmoke(64);
    for (let step = 0; step < 6; step++) {
      a.advance(0.05, step * 0.05, 0, EMPTY, [emitter]);
      b.advance(0.05, step * 0.05, 0, EMPTY, [emitter]);
    }
    a.advance(300, 0.3, 0, EMPTY, [emitter]); // minutes-hidden tab restored
    b.advance(0.05, 0.3, 0, EMPTY, [emitter]); // what the clamp reduces it to
    const pa = [...(a.points.geometry.getAttribute('position').array as Float32Array)];
    const pb = [...(b.points.geometry.getAttribute('position').array as Float32Array)];
    expect(pa).toEqual(pb);
    a.dispose();
    b.dispose();
  });

  it('attributes spawns per emitter — equal rates get equal wisps at constant dt', () => {
    // A shared debt accumulator phase-locks at vsync-constant dt and starves
    // one twin (regression: review finding on d736198).
    const left: MistEmitter = { x: -60, y: 0, z: 0, radius: 1, rate: 2, color: new THREE.Color('#ff0000') };
    const right: MistEmitter = { x: 60, y: 0, z: 0, radius: 1, rate: 2, color: new THREE.Color('#0000ff') };
    const smoke = createMistSmoke(256);
    for (let step = 0; step < 120; step++) smoke.advance(0.05, step * 0.05, 0, EMPTY, [left, right]); // 6s
    const pos = smoke.points.geometry.getAttribute('position').array as Float32Array;
    const age = smoke.points.geometry.getAttribute('aAge').array as Float32Array;
    let leftCount = 0;
    let rightCount = 0;
    for (let i = 0; i < 256; i++) {
      if (age[i] >= 1) continue; // dead slot
      if (pos[i * 3] < 0) leftCount++;
      else rightCount++;
    }
    const total = leftCount + rightCount;
    expect(total).toBeGreaterThan(15);
    // Both twins must emit — and near-evenly (a shared accumulator gives 100/0).
    expect(leftCount).toBeGreaterThanOrEqual(total * 0.4);
    expect(rightCount).toBeGreaterThanOrEqual(total * 0.4);
    smoke.dispose();
  });

  it('drops spawns when the pool saturates instead of hard-cutting live wisps', () => {
    const hot: MistEmitter = { x: 0, y: 0, z: 0, radius: 1, rate: 400, color: new THREE.Color('#fff') };
    const smoke = createMistSmoke(8);
    for (let step = 0; step < 4; step++) smoke.advance(0.05, step * 0.05, 0, EMPTY, [hot]);
    expect(smoke.alive()).toBe(8); // saturated
    const ageAttr = smoke.points.geometry.getAttribute('aAge').array as Float32Array;
    const minAgeBefore = Math.min(...ageAttr);
    smoke.advance(0.05, 0.2, 0, EMPTY, [hot]);
    // A recycle would reset a live slot to age 0; saturation must instead let
    // every live wisp keep aging toward its designed fade-out.
    const minAgeAfter = Math.min(...(smoke.points.geometry.getAttribute('aAge').array as Float32Array));
    expect(minAgeAfter).toBeGreaterThan(minAgeBefore);
    smoke.dispose();
  });

  it('dt=0 (reduced motion) spawns nothing and moves nothing', () => {
    const smoke = createMistSmoke(32);
    for (let step = 0; step < 4; step++) smoke.advance(0.05, step * 0.05, 0, EMPTY, [emitter]); // seed wisps
    const before = [...(smoke.points.geometry.getAttribute('position').array as Float32Array)];
    const aliveBefore = smoke.alive();
    expect(aliveBefore).toBeGreaterThan(0);
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

  it('takes a per-node seed — same-radius shells must not render cloned smoke', () => {
    const a = createMistShell(1.6, '#fff', '#000', universeEmission('forming'), 12345);
    const b = createMistShell(1.6, '#fff', '#000', universeEmission('forming'), 67890);
    const ua = (a.mesh.material as THREE.ShaderMaterial).uniforms.uSeed.value as number;
    const ub = (b.mesh.material as THREE.ShaderMaterial).uniforms.uSeed.value as number;
    expect(ua).not.toBe(ub);
    a.dispose();
    b.dispose();
  });

  it('setDensityScale fades transiently without touching the encoded profile', () => {
    const shell = createMistShell(1, '#fff', '#000', universeEmission('forming'));
    const mat = shell.mesh.material as THREE.ShaderMaterial;
    const encoded = mat.uniforms.uDensity.value as number;
    shell.setDensityScale(0.25);
    expect(mat.uniforms.uDensity.value).toBeCloseTo(encoded * 0.25, 6);
    // Re-applying a profile keeps the transient scale in force…
    shell.setProfile(universeEmission('dormant'));
    expect(mat.uniforms.uDensity.value).toBeCloseTo(universeEmission('dormant').shellDensity * 0.25, 6);
    // …and restoring the scale restores the pure encoding.
    shell.setDensityScale(1);
    expect(mat.uniforms.uDensity.value).toBeCloseTo(universeEmission('dormant').shellDensity, 6);
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
