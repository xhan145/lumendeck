import * as THREE from 'three';
import type { WorkflowNode } from '../../../core/types';
import { orbWorldCenter } from './projection';
import { massFromHeight } from './nodeSpace';
import { weightT } from './orbWeight';
import { GRID_Y } from './scene';

/**
 * Gravity-fabric layer for the 3D constellation: a horizontal plane at grid
 * height that dips into gaussian "wells" under each weighted node — depth AND
 * width encoding the node's normalized primary weight (mass). Contour lines read
 * the field. STATELESS: displacement is a pure function of the well uniforms, so
 * it is starvation-immune and mirrored on the CPU (fabricDisplacement) for tests.
 *
 * The THREE builder (createFabric) lives at the bottom; everything above is pure.
 */

/** Hard cap on simultaneous wells (uniform array length). */
export const MAX_WELLS = 64;

/** Max downward dip (world units) at weightT = 1. */
const DEPTH_SCALE = 150;
/** Gaussian sigma at weightT 0 → 1 (heavier mass = wider well). */
const SIGMA_MIN = 130;
const SIGMA_MAX = 340;

/** Vertex-shader plane densities per quality tier (mid = the slice default). */
export const FABRIC_SEGMENTS = { minimal: 64, standard: 128, rich: 192, cinematic: 256 } as const;
export type FabricTier = keyof typeof FABRIC_SEGMENTS;

/** The geometry of one gravity well — what the displacement math needs. */
export interface WellShape {
  x: number;
  z: number;
  depth: number;
  sigma: number;
}

/** A packed well: geometry plus the node it encodes (for live-position tracking). */
export interface Well extends WellShape {
  nodeId: string;
}

/**
 * Derive wells from a node list. Weightless nodes (null weightT) produce NO well
 * (flat fabric is the honest rendering). If more than MAX_WELLS qualify, the
 * deepest MAX_WELLS are kept and `clamped` is true (caller warns once).
 */
export function packWells(nodes: readonly WorkflowNode[]): { wells: Well[]; clamped: boolean } {
  const all: Well[] = [];
  for (const node of nodes) {
    const t = weightT(node.kind, node.params);
    if (t == null) continue; // weightless kind → no well
    const c = orbWorldCenter(node);
    // Height → mass: a lifted node warps spacetime more (deeper + wider well);
    // ×1 at the neutral reference so ordinary layouts are unchanged. sigma keeps
    // a smaller exponent so width grows more gently than depth.
    const mass = massFromHeight(c.y);
    all.push({
      nodeId: node.id,
      x: c.x,
      z: c.z,
      depth: t * DEPTH_SCALE * mass,
      sigma: (SIGMA_MIN + t * (SIGMA_MAX - SIGMA_MIN)) * Math.sqrt(mass),
    });
  }
  if (all.length <= MAX_WELLS) return { wells: all, clamped: false };
  const kept = [...all].sort((a, b) => b.depth - a.depth).slice(0, MAX_WELLS);
  return { wells: kept, clamped: true };
}

/**
 * CPU mirror of the vertex-shader displacement: total downward dip (world units,
 * ≥0) at world (x, z) from the superposition of all wells. Exact same math the
 * GPU runs, so unit tests validate the visual field.
 */
export function fabricDisplacement(x: number, z: number, wells: readonly WellShape[]): number {
  let disp = 0;
  for (const w of wells) {
    const dx = x - w.x;
    const dz = z - w.z;
    const r2 = dx * dx + dz * dz;
    const sigma = Math.max(w.sigma, 1);
    disp += w.depth * Math.exp(-r2 / (2 * sigma * sigma));
  }
  return disp;
}

// ---- Ambient micro-waves (higher tiers only; slow, low, non-signaling) -----

/**
 * CPU mirror of the vertex-shader ambient-wave term: a small multi-scale swell
 * (world units) at world (x, z) at time `tSec`. Amplitude 0 = perfectly static
 * (the lower tiers and reduced motion). Deliberately SLOW and LOW — idle motion
 * must read as a liquid at rest, never as a signal; project events (ripples)
 * stay the only strong disturbances. Exact same math the shader runs.
 */
export function fabricWave(x: number, z: number, tSec: number, amp: number): number {
  if (amp <= 0) return 0;
  return amp * (
    Math.sin(x * 0.011 + tSec * 0.7) * Math.sin(z * 0.013 - tSec * 0.55) +
    0.5 * Math.sin((x + z) * 0.021 + tSec * 1.13)
  );
}

// ---- Event ripples (transient waves fired by events, e.g. a new anomaly) ---

/** Max simultaneous ripple events (uniform array length). */
export const MAX_RIPPLES = 8;
/** Crest expansion speed (world units / second). */
const RIPPLE_SPEED = 720;
/** Time-decay constant (seconds); amplitude ≈ e^-1 after this. */
const RIPPLE_TAU = 0.5;
/** Radial half-width of the ring crest (world units). */
const RIPPLE_WIDTH = 130;
/** Default crest height (world units). */
export const RIPPLE_AMP = 46;
/** A ripple is dead once its age exceeds this (seconds) — ~e^-3.6 amplitude. */
export const RIPPLE_LIFETIME = 1.8;

/** One ripple event: world xz origin, wall-clock start (ms), crest height. */
export interface Ripple {
  x: number;
  z: number;
  t0: number;
  amp: number;
}

/** Age (seconds) of a ripple at time `now` (ms). */
export function rippleAge(ripple: Ripple, now: number): number {
  return (now - ripple.t0) / 1000;
}

/** True while a ripple is still within its lifetime at `now`. */
export function rippleAlive(ripple: Ripple, now: number): boolean {
  const age = rippleAge(ripple, now);
  return age >= 0 && age <= RIPPLE_LIFETIME;
}

/**
 * CPU mirror of the vertex-shader ripple term: total UPWARD offset (world units,
 * ≥0) at world (x, z) from all live ripples at time `now` (ms). Each ripple is a
 * gaussian ring crest at radius SPEED·age, fading with e^(-age/TAU). Exact same
 * math the shader runs (which receives the pre-computed age), so tests validate it.
 */
export function rippleDisplacement(x: number, z: number, ripples: readonly Ripple[], now: number): number {
  let lift = 0;
  for (const rp of ripples) {
    const age = rippleAge(rp, now);
    if (age < 0 || age > RIPPLE_LIFETIME) continue;
    const dx = x - rp.x;
    const dz = z - rp.z;
    const r = Math.sqrt(dx * dx + dz * dz);
    const ring = r - RIPPLE_SPEED * age;
    lift += rp.amp * Math.exp(-age / RIPPLE_TAU) * Math.exp(-(ring * ring) / (2 * RIPPLE_WIDTH * RIPPLE_WIDTH));
  }
  return lift;
}

// ---- THREE builder (three-only; construction needs no GL context) ----------

/** Plane extent (world units) — matches the main neon grid so it reads as ground. */
export const FABRIC_EXTENT = 4800;
/** World-radial distance over which the plane fades to alpha 0 (into the DOM bg). */
const FADE_START = 1500;
const FADE_END = 2300;
/** Displacement (world units) between equipotential contour lines. */
const CONTOUR_SPACING = 26;

// GLSL ES 3.00 (THREE.GLSL3): fwidth/derivatives are core on WebGL2 — no
// extension flag needed. three injects #version, precision, position, and the
// model/projection matrices; we declare only our own in/out + uniforms.
const FABRIC_VERTEX_SHADER = /* glsl */ `
  uniform vec4 uWells[${MAX_WELLS}];     // xy = world xz, z = depth, w = sigma
  uniform int uWellCount;
  uniform vec4 uRipples[${MAX_RIPPLES}]; // xy = world xz, z = age (s), w = amp
  uniform int uRippleCount;
  uniform float uRippleSpeed;
  uniform float uRippleTau;
  uniform float uRippleWidth;
  uniform float uTime;      // ambient-wave clock (seconds); frozen while idle
  uniform float uWaveAmp;   // ambient micro-wave amplitude (0 = static sheet)
  out float vDisp;
  out vec2 vWorldXZ;
  out vec3 vViewPos;
  void main() {
    vec3 p = position;                   // plane laid flat: p.x, p.z are world xz
    float disp = 0.0;
    for (int i = 0; i < ${MAX_WELLS}; i++) {
      if (i >= uWellCount) break;
      vec4 w = uWells[i];
      float dx = p.x - w.x;
      float dz = p.z - w.y;
      float r2 = dx * dx + dz * dz;
      float sigma = max(w.w, 1.0);
      disp += w.z * exp(-r2 / (2.0 * sigma * sigma));
    }
    // Event ripples: gaussian ring crests expanding at uRippleSpeed, fading over
    // uRippleTau. They RAISE the fabric (opposite sign to wells) so a disturbance
    // reads as a wave passing over the depressions. Age is precomputed on the CPU.
    float lift = 0.0;
    for (int j = 0; j < ${MAX_RIPPLES}; j++) {
      if (j >= uRippleCount) break;
      vec4 rp = uRipples[j];
      float age = rp.z;
      float rx = p.x - rp.x;
      float rz = p.z - rp.y;
      float r = sqrt(rx * rx + rz * rz);
      float ring = r - uRippleSpeed * age;
      lift += rp.w * exp(-age / uRippleTau) * exp(-(ring * ring) / (2.0 * uRippleWidth * uRippleWidth));
    }
    // Ambient micro-waves (multi-scale, slow, LOW amplitude — mirrors
    // fabricWave on the CPU). Data channels are untouched: vDisp below stays
    // the pure well displacement, so contour lines never wobble with the swell.
    if (uWaveAmp > 0.0) {
      lift += uWaveAmp * (
        sin(p.x * 0.011 + uTime * 0.7) * sin(p.z * 0.013 - uTime * 0.55) +
        0.5 * sin((p.x + p.z) * 0.021 + uTime * 1.13)
      );
    }
    p.y -= disp;
    p.y += lift;
    vDisp = disp;
    vWorldXZ = vec2(p.x, p.z);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewPos = mv.xyz;                    // view space → fragment derives the normal
    gl_Position = projectionMatrix * mv;
  }
`;

const FABRIC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uShallow;   // brand cyan — flat / shallow liquid
  uniform vec3 uDeep;      // brand violet — deep well
  uniform float uDepthScale;
  uniform float uContourSpacing;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  in float vDisp;
  in vec2 vWorldXZ;
  in vec3 vViewPos;
  out vec4 fragColor;
  void main() {
    // Real surface normal of the deformed sheet, from screen-space derivatives of
    // the view-space position — captures every well dip AND ripple wave, so the
    // "fabric of spacetime" shades like a liquid-metal / mercury surface.
    vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    vec3 V = normalize(-vViewPos);          // camera sits at the origin in view space
    float ndv = max(dot(N, V), 0.0);

    // Base depth tint: deeper wells pull toward violet, shallows read cyan.
    float d = clamp(vDisp / uDepthScale, 0.0, 1.0);
    vec3 base = mix(uShallow, uDeep, d);

    // Liquid-metal sheen: a fresnel rim + a fake reflected-"sky" gradient sampled
    // by the reflected view vector. Grazing angles reflect more (like mercury).
    float fres = pow(1.0 - ndv, 4.0);
    vec3 R = reflect(-V, N);
    float sky = R.y * 0.5 + 0.5;            // up-facing facets catch the bright sky
    vec3 skyTint = mix(uDeep * 0.35, uShallow * 1.5 + 0.12, sky);
    vec3 col = mix(base, skyTint, 0.32 + 0.5 * fres);

    // A sharp specular glint from a fixed key light — travels along the wave crests.
    vec3 L = normalize(vec3(0.4, 0.85, 0.35));
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 64.0);
    col += spec * vec3(0.85, 0.92, 1.0);

    // Equipotential contour lines, faintly etched into the metal — the colorblind-
    // safe data read-out survives (luminance, not hue).
    float phase = vDisp / uContourSpacing;
    float aa = fwidth(phase);
    float line = 1.0 - smoothstep(0.0, aa * 1.5, abs(fract(phase - 0.5) - 0.5));
    col += line * 0.14;

    // Opaque liquid sheet in the centre, dissolving into the void at the rim
    // (straight alpha over the transparent canvas — never a fog slab).
    float radial = length(vWorldXZ);
    float alpha = (1.0 - smoothstep(uFadeStart, uFadeEnd, radial)) * 0.82;
    alpha = clamp(alpha + fres * 0.14, 0.0, 0.92);
    if (alpha <= 0.002) discard;
    fragColor = vec4(col, alpha);
  }
`;

export interface FabricHandle {
  /** The scene group to add beside the GridHelpers. */
  readonly group: THREE.Group;
  /** Repack wells from the current graph + upload uniforms. Returns clamp state. */
  update(nodes: readonly WorkflowNode[]): { clamped: boolean };
  /**
   * Update well XZ from live orb positions. Playback/audio move orbs via direct
   * scene mutation (no store commit), so the depressions must follow or they
   * detach. `lookup` returns a node's live world xz, or undefined to keep its
   * home xz. Depth + sigma are preserved from the last update().
   */
  syncLive(lookup: (nodeId: string) => { x: number; z: number } | undefined): void;
  /**
   * Enqueue an event ripple centered at world (x, z), starting at `now` (ms).
   * Drops the oldest if the queue is full. `amp` defaults to RIPPLE_AMP.
   */
  pushRipple(x: number, z: number, now: number, amp?: number): void;
  /**
   * Repack the live ripples' ages into the uniforms at `now` (ms), culling dead
   * ones. Returns true while any ripple is still animating — the "decay active"
   * signal the settle driver keeps rendering on.
   */
  tickRipples(now: number): boolean;
  /** True if any ripple is still alive at `now` (ms), without mutating the queue. */
  ripplesAlive(now: number): boolean;
  /** Advance the ambient-wave clock (seconds). No-op visual when waveAmp = 0. */
  setTime(tSec: number): void;
  /** Remove from parent + dispose geometry/material (idempotent). */
  dispose(): void;
}

/**
 * Build a fabric layer at the given tier density. `shallow`/`deep` are concrete
 * colors — resolve CSS vars (resolveCssColor) before calling. Compositing is
 * pinned per the redteam spec: fog:false, depthWrite:false, renderOrder:-1,
 * straight-alpha fade — correct over the alpha:true canvas, never stomps wires.
 */
export function createFabric(tier: FabricTier, shallow: string, deep: string, waveAmp = 0): FabricHandle {
  const segments = FABRIC_SEGMENTS[tier];
  const geometry = new THREE.PlaneGeometry(FABRIC_EXTENT, FABRIC_EXTENT, segments, segments);
  geometry.rotateX(-Math.PI / 2); // XY plane → XZ ground plane (normal +y)

  const wellData: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_WELLS; i++) wellData.push(new THREE.Vector4(0, 0, 0, 1));

  const rippleData: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_RIPPLES; i++) rippleData.push(new THREE.Vector4(0, 0, 0, 0));

  const material = new THREE.ShaderMaterial({
    vertexShader: FABRIC_VERTEX_SHADER,
    fragmentShader: FABRIC_FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uWells: { value: wellData },
      uWellCount: { value: 0 },
      uShallow: { value: new THREE.Color(shallow) },
      uDeep: { value: new THREE.Color(deep) },
      uDepthScale: { value: DEPTH_SCALE },
      uContourSpacing: { value: CONTOUR_SPACING },
      uFadeStart: { value: FADE_START },
      uFadeEnd: { value: FADE_END },
      uRipples: { value: rippleData },
      uRippleCount: { value: 0 },
      uRippleSpeed: { value: RIPPLE_SPEED },
      uRippleTau: { value: RIPPLE_TAU },
      uRippleWidth: { value: RIPPLE_WIDTH },
      uTime: { value: 0 },
      uWaveAmp: { value: Math.max(0, waveAmp) },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = GRID_Y;
  mesh.renderOrder = -1;
  mesh.frustumCulled = false; // large plane; skip cull cost + edge popping

  const group = new THREE.Group();
  group.add(mesh);

  // The wells packed by the last update(), retained so syncLive can move their
  // XZ to live orb positions while preserving depth/sigma and node identity.
  let packed: Well[] = [];
  // Live event ripples (FIFO, capped at MAX_RIPPLES); ages repacked each tick.
  const ripples: Ripple[] = [];

  return {
    group,
    update(nodes) {
      const { wells, clamped } = packWells(nodes);
      packed = wells;
      const arr = material.uniforms.uWells.value as THREE.Vector4[];
      for (let i = 0; i < wells.length; i++) arr[i].set(wells[i].x, wells[i].z, wells[i].depth, wells[i].sigma);
      material.uniforms.uWellCount.value = wells.length;
      return { clamped };
    },
    syncLive(lookup) {
      const arr = material.uniforms.uWells.value as THREE.Vector4[];
      for (let i = 0; i < packed.length; i++) {
        const w = packed[i];
        const live = lookup(w.nodeId);
        arr[i].set(live ? live.x : w.x, live ? live.z : w.z, w.depth, w.sigma);
      }
    },
    pushRipple(x, z, now, amp = RIPPLE_AMP) {
      ripples.push({ x, z, t0: now, amp });
      if (ripples.length > MAX_RIPPLES) ripples.shift(); // drop the oldest
    },
    tickRipples(now) {
      // Cull dead ripples, then pack (x, z, age, amp) for the survivors.
      for (let i = ripples.length - 1; i >= 0; i--) {
        if (!rippleAlive(ripples[i], now)) ripples.splice(i, 1);
      }
      const arr = material.uniforms.uRipples.value as THREE.Vector4[];
      for (let i = 0; i < ripples.length; i++) {
        const rp = ripples[i];
        arr[i].set(rp.x, rp.z, rippleAge(rp, now), rp.amp);
      }
      material.uniforms.uRippleCount.value = ripples.length;
      return ripples.length > 0;
    },
    ripplesAlive(now) {
      return ripples.some((rp) => rippleAlive(rp, now));
    },
    setTime(tSec) {
      material.uniforms.uTime.value = tSec;
    },
    dispose() {
      group.parent?.remove(group);
      geometry.dispose();
      material.dispose();
    },
  };
}
