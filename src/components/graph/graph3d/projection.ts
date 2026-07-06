import type { WorkflowNode } from '../../../core/types';
import { socketPoint, type Point } from '../wires';

/**
 * Pure projection math for the 3D graph. No DOM, no WebGL — fully unit-testable.
 *
 * Depth (z) is a VIEW concern: `WorkflowNode` keeps `{x, y}` only (schemaVersion 1
 * untouched). z is derived deterministically from the node's x column so saved
 * workflows need zero migration.
 */

/** Z rule: gentle per-column recession — columns further right sit deeper. */
export const Z_RULE = 0.12;

/** zFromNode: world z of a node's plane from its workflow x (see Z_RULE). */
export function zFromNode(x: number): number {
  return -x * Z_RULE;
}

/** World-space z lift applied to the selected node (toward the default camera). */
export const LIFT = 50;

/** Workflow-canvas point that maps to the world origin (keeps the graph centered). */
export const WORLD_CENTER: Point = { x: 640, y: 360 };

/** Canvas-px -> world-unit scale. CSS3DRenderer keeps 1 CSS px = 1 world unit. */
export const WORLD_SCALE = 1;

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

/** Plain [x, y, z] tuple so callers can stay three-free. */
export type Vec3 = [number, number, number];

/**
 * Map a workflow-canvas point (screen-down y) to a three.js world point (y-up)
 * on the plane z. Inverse of `canvasFromWorld`.
 */
export function worldFromCanvas(p: Point, z = 0): WorldPoint {
  return {
    x: (p.x - WORLD_CENTER.x) * WORLD_SCALE,
    y: -(p.y - WORLD_CENTER.y) * WORLD_SCALE,
    z,
  };
}

/** Inverse of `worldFromCanvas` (x/y only — z is a pure view concern). */
export function canvasFromWorld(wx: number, wy: number): Point {
  return {
    x: wx / WORLD_SCALE + WORLD_CENTER.x,
    y: WORLD_CENTER.y - wy / WORLD_SCALE,
  };
}

/**
 * World position of a node's top-left corner — the point its DOM card anchors
 * to. y is negated (screen-down -> world-up); selected nodes lift by LIFT.
 */
export function worldFromNode(node: WorkflowNode, selected: boolean): WorldPoint {
  return worldFromCanvas({ x: node.x, y: node.y }, zFromNode(node.x) + (selected ? LIFT : 0));
}

/**
 * World position of a socket anchor, built ON TOP of the 2D `socketPoint`
 * offsets from wires.ts (single source of port geometry).
 */
export function socketWorldPoint(node: WorkflowNode, socketId: string, dir: 'in' | 'out', selected: boolean): WorldPoint {
  return worldFromCanvas(socketPoint(node, socketId, dir), zFromNode(node.x) + (selected ? LIFT : 0));
}

const PARALLEL_EPS = 1e-6;

/**
 * Intersect a pointer ray with the plane z = planeZ and return the hit in
 * WORKFLOW coordinates (the inverse of `worldFromNode`). Returns null for
 * near-parallel rays and for planes behind the ray origin.
 */
export function pointerRayToPlane(origin: Vec3, dir: Vec3, planeZ: number): Point | null {
  const dz = dir[2];
  if (Math.abs(dz) < PARALLEL_EPS) return null;
  const t = (planeZ - origin[2]) / dz;
  if (t < 0) return null;
  return canvasFromWorld(origin[0] + dir[0] * t, origin[1] + dir[1] * t);
}
