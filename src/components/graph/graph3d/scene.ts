import * as THREE from 'three';
import type { WorldPoint } from './projection';
import { ringAngle } from './orbWeight';

/**
 * Three.js scene helpers for the 3D graph view: neon ground grid, wire lines,
 * CSS-variable color resolution, and disposal. Kept out of Graph3DView.tsx so
 * the component stays focused on interaction wiring.
 */

/** World y of the neon ground grid (below the node plane band). */
export const GRID_Y = -620;

const WIRE_SEGMENTS = 28;
/** How far a wire's control point bows toward the camera (world units). */
const WIRE_ARC = 40;
const FALLBACK_COLOR = '#8fa3bf';

/**
 * Resolve a `var(--token)` CSS color (as returned by wires.ts socketColor) to
 * a concrete color string three.js can parse. Concrete colors pass through.
 *
 * NEVER returns a `var(...)` string: token names may contain underscores
 * (--sock-lora_stack, --sock-upscale_model — the old regex missed those), and
 * an unresolved var() handed to THREE.Color floods the console with "Unknown
 * color model" warnings. Any var-shaped value that cannot be resolved falls
 * back to a neutral slate instead.
 */
export function resolveCssColor(value: string, el: Element): string {
  const v = value.trim();
  const match = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(v);
  if (!match) return v.startsWith('var(') ? FALLBACK_COLOR : v;
  if (typeof getComputedStyle !== 'function') return FALLBACK_COLOR;
  const resolved = getComputedStyle(el).getPropertyValue(match[1]).trim();
  return resolved || FALLBACK_COLOR;
}

/** Receding neon ground: a brand-colored grid plus a fainter oversized halo grid. */
export function buildNeonGrid(cyan: string, violet: string): THREE.Group {
  const group = new THREE.Group();

  const main = new THREE.GridHelper(4800, 48, new THREE.Color(cyan), new THREE.Color(violet));
  const mainMat = main.material as THREE.LineBasicMaterial;
  mainMat.transparent = true;
  mainMat.opacity = 0.16;
  mainMat.depthWrite = false;
  main.position.y = GRID_Y;
  group.add(main);

  const halo = new THREE.GridHelper(9600, 24, new THREE.Color(violet), new THREE.Color(cyan));
  const haloMat = halo.material as THREE.LineBasicMaterial;
  haloMat.transparent = true;
  haloMat.opacity = 0.07;
  haloMat.depthWrite = false;
  halo.position.y = GRID_Y - 40;
  group.add(halo);

  return group;
}

/**
 * The quadratic-bezier control point every wire bows through. Exported (pure)
 * so the energy-flow pulse layer samples the EXACT same curve the line renders.
 */
export function wireControl(from: WorldPoint, to: WorldPoint): WorldPoint {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
    z: Math.max(from.z, to.z) + WIRE_ARC,
  };
}

function wireCurve(from: WorldPoint, to: WorldPoint): THREE.QuadraticBezierCurve3 {
  const c = wireControl(from, to);
  return new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(c.x, c.y, c.z),
    new THREE.Vector3(to.x, to.y, to.z),
  );
}

/**
 * Build a glowing wire between two socket world points. Solid wires use
 * additive blending (neon over the dark bg); the in-progress draft is dashed.
 */
export function makeWireLine(from: WorldPoint, to: WorldPoint, color: string, dashed = false): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(wireCurve(from, to).getPoints(WIRE_SEGMENTS));
  const material = dashed
    ? new THREE.LineDashedMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.95, dashSize: 12, gapSize: 9 })
    : new THREE.LineBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
  const line = new THREE.Line(geometry, material);
  if (dashed) line.computeLineDistances();
  return line;
}

/** Re-route an existing wire line in place (used by the live draft wire). */
export function updateWireLine(line: THREE.Line, from: WorldPoint, to: WorldPoint): void {
  line.geometry.setFromPoints(wireCurve(from, to).getPoints(WIRE_SEGMENTS));
  line.geometry.computeBoundingSphere();
  if ((line.material as THREE.LineDashedMaterial).isLineDashedMaterial) line.computeLineDistances();
}

// ---- Orb node rendering (the v0.13 'orbs' 3D style) -----------------------

/** How strongly the capsule category accent tints an orb's gradient (0..1). */
const ORB_ACCENT_MIX = 0.16;
/** Ring sits just outside the orb surface. */
const ORB_RING_GAP = 9;
const ORB_RING_TUBE = 2.4;

const ORB_VERTEX_SHADER = /* glsl */ `
  uniform float uRadius;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  void main() {
    // 0 at the orb's south pole, 1 at its north pole — drives the gradient.
    vT = clamp(position.y / uRadius * 0.5 + 0.5, 0.0, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const ORB_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uMid;
  uniform vec3 uHigh;
  uniform vec3 uAccent;
  uniform float uAccentMix;
  uniform float uEmissive;   // 0..1 activity glow (luminosity encoding)
  uniform float uTime;       // shimmer clock (s); frozen at idle by design
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vViewPos;

  // Cheap 3D value noise (two hash octaves) — enough structure for surface
  // convection cells without a texture fetch.
  float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3(i);
    float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  void main() {
    // Three-stop vertical gradient (low -> mid -> high), branchless.
    float lowMix = clamp(vT * 2.0, 0.0, 1.0);
    float highMix = clamp(vT * 2.0 - 1.0, 0.0, 1.0);
    vec3 grad = mix(mix(uLow, uMid, lowMix), uHigh, highMix);
    vec3 base = mix(grad, uAccent, uAccentMix);
    // Cheap smooth shading: view-space half-lambert + fresnel rim glow, so no
    // scene lights are needed (the scene is otherwise unlit line work).
    vec3 n = normalize(vNormal);
    vec3 viewDir = normalize(-vViewPos);
    float diff = 0.5 + 0.5 * max(dot(n, normalize(vec3(0.35, 0.85, 0.45))), 0.0);
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.6);
    // Surface convection: two noise octaves slowly crawling over the sphere
    // break the smooth-gradient-ball look. Luminance-only (±9%), so the
    // node's DATA colors survive untouched. uTime advances only while an
    // animation loop is already running — a still scene stays still.
    float conv = vnoise(n * 3.0 + vec3(0.0, uTime * 0.05, 0.0));
    conv = conv * 0.65 + vnoise(n * 7.0 - vec3(uTime * 0.03)) * 0.35;
    float surface = 1.0 + (conv - 0.5) * 0.18;
    // Corona shimmer rides the rim, strengthened by activity (uEmissive).
    float shimmer = 0.85 + 0.3 * vnoise(n * 5.0 + vec3(uTime * 0.11));
    vec3 color = base * (0.38 + 0.62 * diff) * surface + base * rim * 0.85 * shimmer;
    // Luminosity: a recently-touched node energizes toward a brighter, whiter
    // glow with a hotter internal core (center-weighted boost).
    float core = pow(max(dot(n, viewDir), 0.0), 2.0);
    color += (base + vec3(0.18)) * uEmissive * 0.55;
    color += vec3(0.9, 0.95, 1.0) * core * uEmissive * 0.35;
    gl_FragColor = vec4(color, clamp(0.97 + uEmissive * 0.03, 0.0, 1.0));
  }
`;

/** Shared, cached orb sphere geometry (smooth-shaded). Dispose on teardown. */
export function makeOrbGeometry(radius: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(radius, 48, 32);
}

/** Gradient orb material: three-stop vertical ramp + subtle category tint. */
export function makeOrbMaterial(stops: [string, string, string], accent: string, radius: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ORB_VERTEX_SHADER,
    fragmentShader: ORB_FRAGMENT_SHADER,
    transparent: true,
    uniforms: {
      uRadius: { value: radius },
      uLow: { value: new THREE.Color(stops[0]) },
      uMid: { value: new THREE.Color(stops[1]) },
      uHigh: { value: new THREE.Color(stops[2]) },
      uAccent: { value: new THREE.Color(accent) },
      uAccentMix: { value: ORB_ACCENT_MIX },
      uEmissive: { value: 0 },
      uTime: { value: 0 },
    },
  });
}

/** Live-update an orb material's gradient (param edits re-tint in place). */
export function updateOrbMaterial(material: THREE.ShaderMaterial, stops: [string, string, string], accent: string): void {
  (material.uniforms.uLow.value as THREE.Color).set(stops[0]);
  (material.uniforms.uMid.value as THREE.Color).set(stops[1]);
  (material.uniforms.uHigh.value as THREE.Color).set(stops[2]);
  (material.uniforms.uAccent.value as THREE.Color).set(accent);
}

/** Set an orb's luminosity glow (0..1) — the activity-recency emissive. */
export function setOrbEmissive(material: THREE.ShaderMaterial, value: number): void {
  material.uniforms.uEmissive.value = value;
}

/**
 * Advance an orb's shimmer clock (seconds). Only the animation loops call this,
 * so an idle scene's convection/corona stay frozen — the dirty-flag sleep is
 * preserved by construction.
 */
export function setOrbTime(material: THREE.ShaderMaterial, tSec: number): void {
  material.uniforms.uTime.value = tSec;
}

/**
 * Thin equatorial ring arc sweeping ringAngle(t) — "the slider made visible."
 * Unlit + additive blending reads as slightly emissive over the dark scene.
 * Returns null for a zero-length arc (t ~ 0).
 */
export function makeOrbRing(orbRadius: number, t: number, color: string): THREE.Mesh | null {
  const theta = ringAngle(t);
  if (theta < 1e-4) return null;
  const geometry = new THREE.TorusGeometry(orbRadius + ORB_RING_GAP, ORB_RING_TUBE, 10, 72, theta);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(geometry, material);
  // Torus is built in the XY plane; lay it flat so the arc rides the equator.
  ring.rotation.x = Math.PI / 2;
  return ring;
}

/** Dispose every geometry/material under root (idempotent, safe on groups). */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const drawable = obj as Partial<THREE.Line>;
    drawable.geometry?.dispose();
    const material = drawable.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
  });
}
