import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createAtmosphereMaterial,
  createBroadcastMaterial,
  createOpenSignalMaterial,
} from '../src/components/constellation/openSignalMaterial';

describe('createOpenSignalMaterial', () => {
  it('builds a GLSL3 material with all animation uniforms present', () => {
    const m = createOpenSignalMaterial(['#34D6F4', '#7C3AED'], 42, { energy: 1, radius: 2 });
    expect(m.glslVersion).toBe(THREE.GLSL3);
    for (const u of ['uTime', 'uMotion', 'uEnergy', 'uDisplace', 'uSeed', 'uColorA', 'uColorB']) {
      expect(m.uniforms[u], u).toBeDefined();
    }
    expect(m.uniforms.uEnergy.value).toBe(1);
    expect(m.uniforms.uDisplace.value).toBeCloseTo(2 * 0.035, 6);
    m.dispose();
  });

  it('animates through uniforms without replacing objects (loop-safe contract)', () => {
    const m = createOpenSignalMaterial(['#fff', '#000'], 7);
    const timeRef = m.uniforms.uTime;
    m.uniforms.uTime.value = 12.5; // the render loop mutates value only
    expect(m.uniforms.uTime).toBe(timeRef);
    expect(m.uniforms.uTime.value).toBe(12.5);
    m.dispose();
  });

  it('supports selected vs unselected energy states + reduced motion', () => {
    const dim = createOpenSignalMaterial(['#fff', '#000'], 1, { energy: 0.3, motion: 0 });
    expect(dim.uniforms.uEnergy.value).toBeCloseTo(0.3);
    expect(dim.uniforms.uMotion.value).toBe(0);
    dim.dispose();
  });
});

describe('createAtmosphereMaterial', () => {
  it('is a back-side additive transparent shell with no depth writes', () => {
    const m = createAtmosphereMaterial('#34D6F4', 0.7);
    expect(m.side).toBe(THREE.BackSide);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.uniforms.uIntensity.value).toBeCloseTo(0.7);
    m.dispose();
  });
});

describe('createBroadcastMaterial', () => {
  it('carries inner/outer radii and additive transparent compositing', () => {
    const m = createBroadcastMaterial('#34D6F4', 2, 11);
    expect(m.uniforms.uInner.value).toBe(2);
    expect(m.uniforms.uOuter.value).toBe(11);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.blending).toBe(THREE.AdditiveBlending);
    m.dispose();
  });
});
