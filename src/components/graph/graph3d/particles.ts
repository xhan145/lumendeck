import * as THREE from 'three';
import type { WellShape } from './fabric';
import { GRID_Y } from './scene';

/**
 * Volumetric gravity dust for the constellation. Particles drift, orbit, and
 * plunge through the analytic gravity field instead of reading as a flat sheet.
 * Their sprite size, temperature, opacity, and halo encode motion and depth.
 *
 * Cost remains O(1) per particle: the analytic gradient of up to 64 wells is
 * baked into a coarse grid whenever wells change, then bilinear-sampled per frame.
 */

/** Coarse gravity-grid resolution (cells per side). Rebuilt only when wells change. */
export const GRAVITY_GRID_N = 48;

const PARTICLE_ACCEL = 620;
const PARTICLE_DAMP = 0.94;
const PARTICLE_HOVER = 42;
const PARTICLE_LIFETIME = 10;
const VERTICAL_SPRING = 2.6;
const VERTICAL_DAMP = 0.92;
const ORBIT_STRENGTH = 0.16;
const TURBULENCE = 16;

/**
 * Build the coarse gravity field from the wells: at each cell, the gradient of
 * the well-height field plus the height itself. Pure and unit-testable.
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
        gx += (g * (w.x - x)) / s2;
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
  readonly points: THREE.Points;
  setWells(wells: readonly WellShape[]): void;
  advance(dt: number): void;
  dispose(): void;
}

const POINT_VERTEX_SHADER = /* glsl */ `
  uniform float uSize;
  uniform float uTime;
  in float aEnergy;
  in float aSeed;
  out float vEnergy;
  out float vSeed;
  out float vDepthFade;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float perspective = 360.0 / max(-mv.z, 1.0);
    float twinkle = 0.84 + 0.16 * sin(uTime * (1.8 + aSeed * 2.2) + aSeed * 31.0);
    gl_PointSize = clamp(uSize * (0.65 + aEnergy * 1.7) * perspective * twinkle, 1.2, 34.0);
    gl_Position = projectionMatrix * mv;
    vEnergy = aEnergy;
    vSeed = aSeed;
    vDepthFade = smoothstep(7000.0, 600.0, -mv.z);
  }
`;

const POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uCool;
  uniform vec3 uHot;
  in float vEnergy;
  in float vSeed;
  in float vDepthFade;
  out vec4 fragColor;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;
    if (r > 1.0) discard;

    float core = exp(-r * r * 18.0);
    float halo = exp(-r * r * 3.2);
    float spark = pow(max(0.0, 1.0 - r), 7.0);
    float energy = clamp(vEnergy, 0.0, 1.0);
    vec3 color = mix(uCool, uHot, smoothstep(0.18, 0.9, energy));
    color += vec3(1.0, 0.86, 0.62) * core * (0.35 + energy * 0.9);

    float alpha = (halo * 0.34 + core * 0.82 + spark * 0.45) * vDepthFade;
    alpha *= 0.72 + fract(vSeed * 91.7) * 0.28;
    fragColor = vec4(color * (0.72 + core * 1.45), alpha);
  }
`;

/**
 * Build a volumetric gravity-dust field. The public shape remains unchanged so
 * Graph3DView and existing tests do not need to know about the richer simulation.
 */
export function createParticleField(count: number, extent: number, color: string): ParticleField {
  const half = extent / 2;
  const positions = new Float32Array(count * 3);
  const energies = new Float32Array(count);
  const seeds = new Float32Array(count);
  const px = new Float32Array(count);
  const py = new Float32Array(count);
  const pz = new Float32Array(count);
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  const vz = new Float32Array(count);
  const age = new Float32Array(count);
  const layer = new Float32Array(count);
  let elapsed = 0;
  let grid = new Float32Array(GRAVITY_GRID_N * GRAVITY_GRID_N * 3);

  let seed = 0x9e3779b9 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const scatter = (i: number) => {
    const radius = Math.sqrt(rand()) * half;
    const angle = rand() * Math.PI * 2;
    px[i] = Math.cos(angle) * radius;
    pz[i] = Math.sin(angle) * radius;
    layer[i] = 24 + rand() * 260;
    py[i] = GRID_Y + layer[i] + (rand() - 0.5) * 180;
    const orbital = 12 + rand() * 34;
    vx[i] = -Math.sin(angle) * orbital;
    vz[i] = Math.cos(angle) * orbital;
    vy[i] = (rand() - 0.5) * 18;
    age[i] = 0;
    seeds[i] = rand();
    energies[i] = 0.12 + rand() * 0.22;
  };

  for (let i = 0; i < count; i++) {
    scatter(i);
    age[i] = rand() * PARTICLE_LIFETIME;
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const energyAttr = new THREE.BufferAttribute(energies, 1);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  energyAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('aEnergy', energyAttr);
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

  const cool = new THREE.Color(color);
  const hot = cool.clone().lerp(new THREE.Color('#ffd7a8'), 0.72);
  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
    uniforms: {
      uSize: { value: 13 },
      uTime: { value: 0 },
      uCool: { value: cool },
      uHot: { value: hot },
    },
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 0;

  return {
    points,
    setWells(wells) {
      grid = buildGravityGrid(wells, GRAVITY_GRID_N, extent);
    },
    advance(dt) {
      const d = Math.min(Math.max(dt, 0), 0.05);
      elapsed += d;
      material.uniforms.uTime.value = elapsed;

      for (let i = 0; i < count; i++) {
        const s = sampleGravityGrid(grid, GRAVITY_GRID_N, extent, px[i], pz[i]);
        const gravityMagnitude = Math.min(1, Math.hypot(s.gx, s.gz) * 24);
        const inv = 1 / Math.max(Math.hypot(s.gx, s.gz), 0.0001);
        const tx = -s.gz * inv;
        const tz = s.gx * inv;
        const noise = Math.sin(elapsed * (0.8 + seeds[i]) + seeds[i] * 43.0);

        vx[i] = (vx[i] + (s.gx * PARTICLE_ACCEL + tx * ORBIT_STRENGTH * s.h + noise * TURBULENCE) * d) * PARTICLE_DAMP;
        vz[i] = (vz[i] + (s.gz * PARTICLE_ACCEL + tz * ORBIT_STRENGTH * s.h - noise * TURBULENCE) * d) * PARTICLE_DAMP;

        const targetY = GRID_Y - s.h + PARTICLE_HOVER + layer[i];
        vy[i] = (vy[i] + (targetY - py[i]) * VERTICAL_SPRING * d) * VERTICAL_DAMP;
        py[i] += vy[i] * d;
        px[i] += vx[i] * d;
        pz[i] += vz[i] * d;
        age[i] += d;

        if (age[i] > PARTICLE_LIFETIME || Math.abs(px[i]) > half || Math.abs(pz[i]) > half) scatter(i);

        const speed = Math.min(1, Math.hypot(vx[i], vy[i], vz[i]) / 180);
        energies[i] = Math.min(1, 0.1 + gravityMagnitude * 0.62 + speed * 0.48);
        positions[i * 3] = px[i];
        positions[i * 3 + 1] = py[i];
        positions[i * 3 + 2] = pz[i];
      }

      positionAttr.needsUpdate = true;
      energyAttr.needsUpdate = true;
    },
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
