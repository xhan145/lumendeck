import * as THREE from 'three';
import type { WorldPoint } from './projection';

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
 * a concrete color string three.js can parse. Non-var values pass through.
 */
export function resolveCssColor(value: string, el: Element): string {
  const match = /^var\((--[A-Za-z0-9-]+)\)$/.exec(value.trim());
  if (!match) return value;
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

function wireCurve(from: WorldPoint, to: WorldPoint): THREE.QuadraticBezierCurve3 {
  const control = new THREE.Vector3(
    (from.x + to.x) / 2,
    (from.y + to.y) / 2,
    Math.max(from.z, to.z) + WIRE_ARC,
  );
  return new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(from.x, from.y, from.z),
    control,
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
