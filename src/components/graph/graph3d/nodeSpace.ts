import type { WorkflowNode } from '../../../core/types';

/**
 * Node 3D-placement math for the constellation. PURE — no DOM, no three; fully
 * unit-testable (tests/nodeSpace.test.ts). This is the low-level depth authority;
 * projection.ts re-exports `zFromNode`/`Z_RULE` and routes node depth through
 * `nodeDepth` (one-way dependency projection → nodeSpace, no import cycle).
 *
 * Two concerns live here so nothing else has to know the rules:
 *  1. DEPTH — a node's world z is either its explicit `z` (free 3rd-axis
 *     placement, persisted) or the legacy per-column derivation `zFromNode(x)`.
 *     Every projection helper routes depth through `nodeDepth` so freeing z is a
 *     one-line change everywhere and old saves (no `z`) render identically.
 *  2. HEIGHT → MASS — how high a node floats above the layout midline scales how
 *     much it warps spacetime (deeper/wider gravity well, stronger particle
 *     pull). Neutral (×1) within a deadband around the reference so ordinary
 *     layouts stay unchanged; mass only grows when a node is *deliberately*
 *     lifted (or sunk). Clamped + monotonic.
 */

/** Z rule: gentle per-column recession — columns further right sit deeper. */
export const Z_RULE = 0.12;

/** zFromNode: derived world z of a node's plane from its workflow x column. */
export function zFromNode(x: number): number {
  return -x * Z_RULE;
}

/** World y (height) at which a node's mass multiplier is exactly 1 (neutral). */
export const MASS_REFERENCE_Y = 0;
/** Half-width (world units) of the neutral band around the reference height. */
export const MASS_DEADBAND = 150;
/** World units of lift beyond the deadband per +1.0 of mass multiplier. */
export const MASS_SPAN = 500;
/** Mass multiplier clamps (a sunk node never vanishes; a lifted one is bounded). */
export const MASS_MIN = 0.4;
export const MASS_MAX = 2.4;

/** World z of a node: explicit `z` (free placement) or the legacy column rule. */
export function nodeDepth(node: Pick<WorkflowNode, 'x'> & { z?: number }): number {
  return typeof node.z === 'number' && Number.isFinite(node.z) ? node.z : zFromNode(node.x);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Mass multiplier from a node's world-y height. ×1 inside the deadband around
 * MASS_REFERENCE_Y; beyond it, rises with height and falls when sunk, clamped to
 * [MASS_MIN, MASS_MAX]. Monotonic non-decreasing in worldY.
 */
export function massFromHeight(worldY: number): number {
  if (!Number.isFinite(worldY)) return 1;
  const d = worldY - MASS_REFERENCE_Y;
  const ad = Math.abs(d);
  if (ad <= MASS_DEADBAND) return 1;
  const excess = (ad - MASS_DEADBAND) * Math.sign(d);
  return clamp(1 + excess / MASS_SPAN, MASS_MIN, MASS_MAX);
}
