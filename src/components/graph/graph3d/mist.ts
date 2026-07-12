import * as THREE from 'three';
import { velocityAt, type FlowContext, type Vec3Out } from './flowField';

/**
 * Mist rendering for both 3D surfaces: a single soft-sprite smoke layer
 * (curl-noise-advected wisps; ONE draw call) and per-body billboard mist
 * shells (bounded volumetric shrouds; no raymarch loop). Sprites and shells
 * are procedural — zero texture assets, the MSI stays slim.
 *
 * Everything data-driven: `universeEmission` maps a node's status/strength to
 * shroud density + wisp rate; `graphEmission` maps nodeMeta activity recency
 * to steam around a freshly-touched orb (same half-life as the luminosity
 * glow). Reduced motion freezes the field by freezing the time the caller
 * passes; densities remain — the encoding survives motionless.
 */

// ---- pure emission mappings -------------------------------------------------

export interface MistEmissionProfile {
  /** Billboard shroud opacity budget, 0..1 (0 = no shell). */
  shellDensity: number;
  /** Wisp spawns per second contributed by this body. */
  wispRate: number;
  /** How fast the shroud noise churns (multiplier on shader time). */
  churn: number;
}

export type UniverseStatus = 'active' | 'forming' | 'dormant' | 'complete' | undefined;

/** Universe: mist encodes node status; strength scales emission ±30%. */
export function universeEmission(status: UniverseStatus, strength = 0.5): MistEmissionProfile {
  const scale = 0.7 + 0.6 * Math.min(Math.max(strength, 0), 1);
  switch (status) {
    case 'forming':
      return { shellDensity: 0.85, wispRate: 2.0 * scale, churn: 0.35 };
    case 'dormant':
      return { shellDensity: 0.3, wispRate: 0.25 * scale, churn: 0.06 };
    case 'complete':
      return { shellDensity: 0, wispRate: 0.15 * scale, churn: 0.5 };
    case 'active':
    default:
      return { shellDensity: 0.14, wispRate: 0.85 * scale, churn: 0.8 };
  }
}

/**
 * Graph mode: steam ∝ activity recency (the nodeMeta luminosity datum),
 * decaying on the same half-life so glow and steam tell one story.
 */
export function graphEmission(lastActiveAt: number, nowMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(lastActiveAt) || lastActiveAt <= 0) return 0;
  const age = nowMs - lastActiveAt;
  if (age <= 0) return 1;
  return Math.pow(0.5, age / halfLifeMs);
}

// ---- smoke layer (one Points draw call) -------------------------------------

export interface MistEmitter {
  x: number;
  y: number;
  z: number;
  /** Spawn radius around the emitter. */
  radius: number;
  /** Wisps per second. */
  rate: number;
  color: THREE.Color;
}

export interface MistSmoke {
  readonly points: THREE.Points;
  /**
   * Integrate all live wisps along the flow field and spawn from emitters.
   * `tSec` drives the curl swirl (freeze it for reduced motion); `dt` seconds
   * (already clamped by the caller's loop); `nowMs` only feeds pulse decay.
   */
  advance(dt: number, tSec: number, nowMs: number, ctx: FlowContext, emitters: readonly MistEmitter[]): void;
  /** Live wisp count (for tests/diagnostics). */
  alive(): number;
  dispose(): void;
}

const WISP_LIFETIME = 7; // seconds
const WISP_DRIFT_GAIN = 1.0;
const MIST_VERTEX = /* glsl */ `
  in float aAge;      // 0..1 normalized age
  in float aSeed;
  in vec3 aTint;
  uniform float uSize;
  out float vAge;
  out float vSeed;
  out vec3 vTint;
  void main() {
    vAge = aAge;
    vSeed = aSeed;
    vTint = aTint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Wisps grow as they age and disperse; hide dead sprites at size 0.
    float grow = 0.6 + 0.9 * vAge;
    float alive = step(aAge, 0.999);
    gl_PointSize = alive * uSize * grow * (300.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const MIST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  in float vAge;
  in float vSeed;
  in vec3 vTint;
  out vec4 fragColor;
  float mhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float mnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mhash(i), mhash(i + vec2(1, 0)), f.x),
               mix(mhash(i + vec2(0, 1)), mhash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r = length(q);
    if (r > 0.5) discard;
    // Soft radial body broken up by two octaves of noise — smoke, not a disc.
    float body = smoothstep(0.5, 0.08, r);
    float n = mnoise(q * 5.0 + vSeed * 37.0 + uTime * 0.15) * 0.65
            + mnoise(q * 11.0 - vSeed * 19.0 - uTime * 0.1) * 0.35;
    // Fade in fast, fade out slow over the wisp's life.
    float lifeFade = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
    float alpha = body * smoothstep(0.25, 0.75, n) * lifeFade * uOpacity;
    if (alpha <= 0.004) discard;
    fragColor = vec4(vTint, alpha);
  }
`;

/** mulberry-style deterministic PRNG (no Math.random — tests stay reproducible). */
function makeRand(seedInit: number): () => number {
  let seed = seedInit >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One smoke layer: at most `maxCount` concurrent wisps, one draw call.
 * `flowScale` maps world positions into the curl field's tuned domain and
 * `driftGain` maps field velocity back to world units — so the SAME fluid
 * reads correctly at Universe scale (~planet radii) and Graph scale (~100s of
 * world units): pick flowScale ≈ 1/worldUnitsPerPlanetRadius, driftGain its
 * inverse. CAVEAT: ctx bodies/pulses are compared against SCALED positions —
 * at non-unit flowScale either scale them too or pass an empty ctx (the graph
 * surface does the latter; only the curl term stirs its steam).
 */
export function createMistSmoke(
  maxCount: number,
  opts?: { size?: number; opacity?: number; flowScale?: number; driftGain?: number },
): MistSmoke {
  const flowScale = opts?.flowScale ?? 1;
  const driftGain = (opts?.driftGain ?? 1) * WISP_DRIFT_GAIN;
  const positions = new Float32Array(maxCount * 3);
  const ages = new Float32Array(maxCount).fill(1); // 1 = dead (hidden by shader)
  const seeds = new Float32Array(maxCount);
  const tints = new Float32Array(maxCount * 3);
  const life = new Float32Array(maxCount); // seconds lived; >= WISP_LIFETIME = dead
  life.fill(WISP_LIFETIME);
  const rand = makeRand(0x51f0a7);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const ageAttr = new THREE.BufferAttribute(ages, 1);
  ageAttr.setUsage(THREE.DynamicDrawUsage);
  const seedAttr = new THREE.BufferAttribute(seeds, 1);
  const tintAttr = new THREE.BufferAttribute(tints, 3);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAge', ageAttr);
  geometry.setAttribute('aSeed', seedAttr);
  geometry.setAttribute('aTint', tintAttr);

  const material = new THREE.ShaderMaterial({
    vertexShader: MIST_VERTEX,
    fragmentShader: MIST_FRAGMENT,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending, // smoke occludes softly; it does not glow
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: opts?.size ?? 26 },
      uOpacity: { value: opts?.opacity ?? 0.22 },
    },
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4; // above bodies/atmospheres, below DOM labels

  let cursor = 0;
  let spawnDebt = 0;
  const vel: Vec3Out = { x: 0, y: 0, z: 0 };

  const spawn = (e: MistEmitter) => {
    const i = cursor;
    cursor = (cursor + 1) % maxCount;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * e.radius;
    positions[i * 3] = e.x + Math.cos(a) * r;
    positions[i * 3 + 1] = e.y + (rand() - 0.5) * e.radius * 0.6;
    positions[i * 3 + 2] = e.z + Math.sin(a) * r;
    life[i] = 0;
    seeds[i] = rand();
    tints[i * 3] = e.color.r;
    tints[i * 3 + 1] = e.color.g;
    tints[i * 3 + 2] = e.color.b;
    seedAttr.needsUpdate = true;
    tintAttr.needsUpdate = true;
  };

  return {
    points,
    advance(dt, tSec, nowMs, ctx, emitters) {
      material.uniforms.uTime.value = tSec;
      // Spawning: accumulate fractional debt per emitter so low rates still emit.
      if (dt > 0) {
        for (const e of emitters) {
          if (e.rate <= 0) continue;
          spawnDebt += e.rate * dt;
          while (spawnDebt >= 1) {
            spawn(e);
            spawnDebt -= 1;
          }
        }
      }
      // Advect live wisps along the fluid.
      for (let i = 0; i < maxCount; i++) {
        if (life[i] >= WISP_LIFETIME) {
          ages[i] = 1;
          continue;
        }
        life[i] += dt;
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        velocityAt(x * flowScale, y * flowScale, z * flowScale, tSec, ctx, nowMs, vel);
        positions[i * 3] = x + vel.x * driftGain * dt;
        positions[i * 3 + 1] = y + vel.y * driftGain * dt;
        positions[i * 3 + 2] = z + vel.z * driftGain * dt;
        ages[i] = Math.min(life[i] / WISP_LIFETIME, 1);
      }
      posAttr.needsUpdate = true;
      ageAttr.needsUpdate = true;
    },
    alive() {
      let n = 0;
      for (let i = 0; i < maxCount; i++) if (life[i] < WISP_LIFETIME) n++;
      return n;
    },
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}

// ---- billboard mist shell (bounded volumetric shroud) ------------------------

const SHELL_VERTEX = /* glsl */ `
  out vec2 vUvC;
  void main() {
    vUvC = uv - 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHELL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uDensity;   // data-driven shroud budget (0 = invisible)
  uniform float uChurn;     // data-driven churn speed
  uniform float uSeed;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  in vec2 vUvC;
  out vec4 fragColor;
  float shash(vec2 p) { return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453); }
  float snoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(shash(i), shash(i + vec2(1, 0)), f.x),
               mix(shash(i + vec2(0, 1)), shash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float r = length(vUvC) * 2.0; // 0 center .. 1 edge
    if (r > 1.0 || uDensity <= 0.001) discard;
    float t = uTime * uChurn;
    // Two warped octaves — wispy shroud, not a flat fog disc.
    vec2 w = vUvC * 3.0 + vec2(snoise(vUvC * 2.0 + t * 0.3 + uSeed), snoise(vUvC * 2.0 - t * 0.2 - uSeed));
    float n = snoise(w + t * 0.15) * 0.6 + snoise(w * 2.3 - t * 0.1) * 0.4;
    // Hollow center (the body shows through), feathered outer edge.
    float ring = smoothstep(0.25, 0.55, r) * (1.0 - smoothstep(0.75, 1.0, r));
    float alpha = ring * smoothstep(0.3, 0.8, n) * uDensity;
    if (alpha <= 0.004) discard;
    fragColor = vec4(mix(uColorB, uColorA, n), alpha);
  }
`;

export interface MistShell {
  readonly mesh: THREE.Mesh;
  /** Update shader time (churn-scaled inside) — freeze for reduced motion. */
  setTime(tSec: number): void;
  /** Re-apply a data-driven profile (density/churn) without a rebuild. */
  setProfile(profile: MistEmissionProfile): void;
  dispose(): void;
}

/** A camera-facing shroud quad ~2.6× body radius. Caller billboards it per frame. */
export function createMistShell(bodyRadius: number, colorA: string, colorB: string, profile: MistEmissionProfile): MistShell {
  const size = bodyRadius * 2.6;
  const geometry = new THREE.PlaneGeometry(size, size);
  const material = new THREE.ShaderMaterial({
    vertexShader: SHELL_VERTEX,
    fragmentShader: SHELL_FRAGMENT,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uDensity: { value: profile.shellDensity },
      uChurn: { value: profile.churn },
      uSeed: { value: (Math.imul(bodyRadius * 1000, 2654435761) >>> 8) % 100 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 3; // after the body + atmosphere shell
  return {
    mesh,
    setTime(tSec) {
      material.uniforms.uTime.value = tSec;
    },
    setProfile(profile) {
      material.uniforms.uDensity.value = profile.shellDensity;
      material.uniforms.uChurn.value = profile.churn;
    },
    dispose() {
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
