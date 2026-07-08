import * as THREE from 'three';
import type { WorkflowNode } from '../../../core/types';
import { orbWorldCenter } from './projection';
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
export const FABRIC_SEGMENTS = { minimal: 64, standard: 128, rich: 192 } as const;
export type FabricTier = keyof typeof FABRIC_SEGMENTS;

/** One gravity well: world xz, dip depth (world units), gaussian sigma. */
export interface Well {
  x: number;
  z: number;
  depth: number;
  sigma: number;
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
    all.push({
      x: c.x,
      z: c.z,
      depth: t * DEPTH_SCALE,
      sigma: SIGMA_MIN + t * (SIGMA_MAX - SIGMA_MIN),
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
export function fabricDisplacement(x: number, z: number, wells: readonly Well[]): number {
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

// ---- THREE builder (three-only; construction needs no GL context) ----------

/** Plane extent (world units) — matches the main neon grid so it reads as ground. */
const FABRIC_SIZE = 4800;
/** World-radial distance over which the plane fades to alpha 0 (into the DOM bg). */
const FADE_START = 1500;
const FADE_END = 2300;
/** Displacement (world units) between equipotential contour lines. */
const CONTOUR_SPACING = 26;

// GLSL ES 3.00 (THREE.GLSL3): fwidth/derivatives are core on WebGL2 — no
// extension flag needed. three injects #version, precision, position, and the
// model/projection matrices; we declare only our own in/out + uniforms.
const FABRIC_VERTEX_SHADER = /* glsl */ `
  uniform vec4 uWells[${MAX_WELLS}];   // xy = world xz, z = depth, w = sigma
  uniform int uWellCount;
  out float vDisp;
  out vec2 vWorldXZ;
  void main() {
    vec3 p = position;                 // plane laid flat: p.x, p.z are world xz
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
    p.y -= disp;
    vDisp = disp;
    vWorldXZ = vec2(p.x, p.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FABRIC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uShallow;   // brand cyan — flat fabric
  uniform vec3 uDeep;      // brand violet — deep well
  uniform float uDepthScale;
  uniform float uContourSpacing;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  in float vDisp;
  in vec2 vWorldXZ;
  out vec4 fragColor;
  void main() {
    float d = clamp(vDisp / uDepthScale, 0.0, 1.0);
    vec3 col = mix(uShallow, uDeep, d);

    // Equipotential contour lines — luminance, not hue (colorblind-safe).
    float phase = vDisp / uContourSpacing;
    float aa = fwidth(phase);
    float line = 1.0 - smoothstep(0.0, aa * 1.5, abs(fract(phase - 0.5) - 0.5));
    col += line * 0.35;

    // Straight-alpha radial fade into the transparent DOM background.
    float radial = length(vWorldXZ);
    float alpha = (1.0 - smoothstep(uFadeStart, uFadeEnd, radial)) * 0.5;
    alpha += line * 0.25 * alpha;
    if (alpha <= 0.001) discard;
    fragColor = vec4(col, alpha);
  }
`;

export interface FabricHandle {
  /** The scene group to add beside the GridHelpers. */
  readonly group: THREE.Group;
  /** Repack wells from the current graph + upload uniforms. Returns clamp state. */
  update(nodes: readonly WorkflowNode[]): { clamped: boolean };
  /** Remove from parent + dispose geometry/material (idempotent). */
  dispose(): void;
}

/**
 * Build a fabric layer at the given tier density. `shallow`/`deep` are concrete
 * colors — resolve CSS vars (resolveCssColor) before calling. Compositing is
 * pinned per the redteam spec: fog:false, depthWrite:false, renderOrder:-1,
 * straight-alpha fade — correct over the alpha:true canvas, never stomps wires.
 */
export function createFabric(tier: FabricTier, shallow: string, deep: string): FabricHandle {
  const segments = FABRIC_SEGMENTS[tier];
  const geometry = new THREE.PlaneGeometry(FABRIC_SIZE, FABRIC_SIZE, segments, segments);
  geometry.rotateX(-Math.PI / 2); // XY plane → XZ ground plane (normal +y)

  const wellData: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_WELLS; i++) wellData.push(new THREE.Vector4(0, 0, 0, 1));

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
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = GRID_Y;
  mesh.renderOrder = -1;
  mesh.frustumCulled = false; // large plane; skip cull cost + edge popping

  const group = new THREE.Group();
  group.add(mesh);

  return {
    group,
    update(nodes) {
      const { wells, clamped } = packWells(nodes);
      const arr = material.uniforms.uWells.value as THREE.Vector4[];
      for (let i = 0; i < wells.length; i++) arr[i].set(wells[i].x, wells[i].z, wells[i].depth, wells[i].sigma);
      material.uniforms.uWellCount.value = wells.length;
      return { clamped };
    },
    dispose() {
      group.parent?.remove(group);
      geometry.dispose();
      material.dispose();
    },
  };
}
