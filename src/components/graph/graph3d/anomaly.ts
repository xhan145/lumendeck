import * as THREE from 'three';
import type { HealthIssue } from '../../../core/health';

/**
 * Anomaly encoding for the 3D constellation: a node carrying a health issue gets
 * a palette-breaking outline ring — the ONLY channel allowed to break the brand
 * cyan→violet→mango ramp. PURE level/color logic + a small THREE ring builder.
 *
 * The node chip's health icon+text carries the SAME signal, so this is never
 * color-alone (the standing a11y rule); error rings are thicker than warnings so
 * severity survives colorblindness too.
 */

export type AnomalyLevel = 'error' | 'warning';

/** Worst health severity attributed to a node id, or null when it is clean. */
export function nodeAnomaly(nodeId: string, health: readonly HealthIssue[]): AnomalyLevel | null {
  let warn = false;
  for (const h of health) {
    if (h.nodeId !== nodeId) continue;
    if (h.severity === 'error') return 'error'; // error dominates immediately
    warn = true; // severity is 'warning'
  }
  return warn ? 'warning' : null;
}

/** Palette-breaking color for an anomaly level (red = error, amber = warning). */
export function anomalyColor(level: AnomalyLevel): string {
  return level === 'error' ? '#FF4D5B' : '#FFC24B';
}

/**
 * A full-circle outline ring just outside the orb, colored by severity. Solid
 * (non-additive) so it reads as an alert that BREAKS the neon palette rather
 * than glowing into it; error rings are thicker + brighter than warnings.
 */
export function makeAnomalyRing(orbRadius: number, level: AnomalyLevel): THREE.Mesh {
  const tube = level === 'error' ? 3.4 : 2.2;
  const geometry = new THREE.TorusGeometry(orbRadius + 20, tube, 12, 96);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(anomalyColor(level)),
    transparent: true,
    opacity: level === 'error' ? 0.95 : 0.85,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(geometry, material);
  ring.rotation.x = Math.PI / 2; // lay flat, concentric outside the value ring
  return ring;
}
