import * as THREE from 'three';
import type { WellShape } from './fabric';
import { GRID_Y } from './scene';

/**
 * Gravity dust for the constellation: a Points layer whose particles drift along
 * the gravity field toward the mass wells, dipping into them as they ride the
 * liquid-metal surface. Makes the "mass warps spacetime" story kinetic.
 *
 * Cost is kept O(1) per particle (the redteam budget): the analytic gradient of
 * up to 64 wells is baked ONCE into a coarse grid whenever the wells change, and
 * each particle bilinear-samples that grid per frame instead of summing 64 wells.
 * The grid build + sampling are PURE and unit-tested; only createParticleField
 * touches three.
 */

/** Coarse gravity-grid resolution (cells per side). Rebuilt only when wells change. */
export const GRAVITY_GRID_N = 48;

const PARTICLE_ACCEL = 620; // gravity-gradient → velocity gain
const PARTICLE_DAMP = 0.94; // per-step velocity damping (keeps orbits from flinging out)
const PARTICLE_HOVER = 42; // world units above the fabric surface (floats visibly in space)
const PARTICLE_LIFETIME = 8; // seconds before a particle recycles (keeps fresh dust falling)

/**
 * Build the coarse gravity field from the wells: at each cell, the gradient of
 * the well-height field (points TOWARD wells) plus the height itself. Pure.
 * Layout: grid[(iz*N + ix)*3 + {0: gradX, 1: gradZ, 2: height}].
 */
export function buildGravityGrid(wells: readonly WellShape[], gridN: number, extent: number): Float32Array {
  const grid = new Float32Array(gridN * gridN * 3);
  const half = extent / 2;
  for (let iz = 0; iz < gridN; iz++) {
    const z = -half + (iz / (gridN - 1)) * extent;
    for (let ix = 0; ix < gridN; ix++) {
      const x = -half + (ix / (gridN - 1)) * extent;
      let gx = 0;
      let gz = 0;
      let h = 0;
      for (const w of wells) {
        const dx = x - w.x;
        const dz = z - w.z;
        const s2 = Math.max(w.sigma * w.sigma, 1);
        const g = w.depth * Math.exp(-(dx * dx + dz * dz) / (2 * s2));
        h += g;
        gx += (g * (w.x - x)) / s2; // ∇height: from the cell toward the well
        gz += (g * (w.z - z)) / s2;
      }
      const o = (iz * gridN + ix) * 3;
      grid[o] = gx;
      grid[o + 1] = gz;
      grid[o + 2] = h;
    }
  }
  return grid;
}

/** Bilinear-sample the gravity grid at world (x, z). Pure, O(1). */
export function sampleGravityGrid(
  grid: Float32Array,
  gridN: number,
  extent: number,
  x: number,
  z: number,
): { gx: number; gz: number; h: number } {
  const half = extent / 2;
  const u = Math.min(gridN - 1, Math.max(0, ((x + half) / extent) * (gridN - 1)));
  const v = Math.min(gridN - 1, Math.max(0, ((z + half) / extent) * (gridN - 1)));
  const ix0 = Math.floor(u);
  const iz0 = Math.floor(v);
  const ix1 = Math.min(gridN - 1, ix0 + 1);
  const iz1 = Math.min(gridN - 1, iz0 + 1);
  const tx = u - ix0;
  const tz = v - iz0;
  const at = (ix: number, iz: number, c: number) => grid[(iz * gridN + ix) * 3 + c];
  const bilerp = (c: number) => {
    const a = at(ix0, iz0, c) + (at(ix1, iz0, c) - at(ix0, iz0, c)) * tx;
    const b = at(ix0, iz1, c) + (at(ix1, iz1, c) - at(ix0, iz1, c)) * tx;
    return a + (b - a) * tz;
  };
  return { gx: bilerp(0), gz: bilerp(1), h: bilerp(2) };
}

export interface ParticleField {
  /** The Points object to add to the scene (above the fabric, with the orbs). */
  readonly points: THREE.Points;
  /** Rebuild the gravity grid from the current wells (call when wells change). */
  setWells(wells: readonly WellShape[]): void;
  /** Euler-integrate all particles along the gravity field by `dt` seconds. */
  advance(dt: number): void;
  /** Remove from parent + dispose geometry/material (idempotent). */
  dispose(): void;
}

const POINT_VERTEX_SHADER = /* glsl */ `
  uniform float uSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (320.0 / max(-mv.z, 1.0)); // perspective size attenuation
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  out vec4 fragColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;                 // round soft dust, not a square
    fragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * 0.75);
  }
`;

/**
 * Build a gravity-dust field of `count` particles over a square of `extent`
 * world units, glowing in `color`. Deterministic scatter/respawn (seeded PRNG,
 * no Math.random) so `advance` is reproducible in tests.
 */
export function createParticleField(count: number, extent: number, color: string): ParticleField {
  const half = extent / 2;
  const positions = new Float32Array(count * 3);
  const px = new Float32Array(count);
  const pz = new Float32Array(count);
  const vx = new Float32Array(count);
  const vz = new Float32Array(count);
  const age = new Float32Array(count);
  let grid = new Float32Array(GRAVITY_GRID_N * GRAVITY_GRID_N * 3);

  // mulberry32 — deterministic scatter without Math.random (keeps advance testable).
  let seed = 0x9e3779b9 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const scatter = (i: number) => {
    px[i] = (rand() * 2 - 1) * half;
    pz[i] = (rand() * 2 - 1) * half;
    vx[i] = 0;
    vz[i] = 0;
    age[i] = 0;
  };
  for (let i = 0; i < count; i++) {
    scatter(i);
    age[i] = rand() * PARTICLE_LIFETIME; // stagger initial ages so respawns don't pulse
  }

  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);

  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uSize: { value: 11 },
      uColor: { value: new THREE.Color(color) },
    },
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 0; // above the fabric (renderOrder -1)

  return {
    points,
    setWells(wells) {
      grid = buildGravityGrid(wells, GRAVITY_GRID_N, extent);
    },
    advance(dt) {
      const d = Math.min(Math.max(dt, 0), 0.05); // clamp (tab refocus can't fling dust away)
      for (let i = 0; i < count; i++) {
        const s = sampleGravityGrid(grid, GRAVITY_GRID_N, extent, px[i], pz[i]);
        vx[i] = (vx[i] + s.gx * PARTICLE_ACCEL * d) * PARTICLE_DAMP;
        vz[i] = (vz[i] + s.gz * PARTICLE_ACCEL * d) * PARTICLE_DAMP;
        px[i] += vx[i] * d;
        pz[i] += vz[i] * d;
        age[i] += d;
        if (age[i] > PARTICLE_LIFETIME || Math.abs(px[i]) > half || Math.abs(pz[i]) > half) scatter(i);
        positions[i * 3] = px[i];
        positions[i * 3 + 1] = GRID_Y - s.h + PARTICLE_HOVER; // ride the dipped liquid surface
        positions[i * 3 + 2] = pz[i];
      }
      attr.needsUpdate = true;
    },
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
