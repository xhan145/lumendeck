import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { nodeAnomaly, anomalyColor, makeAnomalyRing } from '../src/components/graph/graph3d/anomaly';
import type { HealthIssue } from '../src/core/health';

const issue = (nodeId: string | undefined, severity: 'error' | 'warning'): HealthIssue => ({
  id: `h_${nodeId}_${severity}`,
  severity,
  code: 'disconnected',
  message: '',
  nodeId,
});

describe('nodeAnomaly', () => {
  it('returns null for a clean node', () => {
    expect(nodeAnomaly('a', [issue('b', 'error')])).toBeNull();
    expect(nodeAnomaly('a', [])).toBeNull();
  });

  it('returns warning when only warnings target the node', () => {
    expect(nodeAnomaly('a', [issue('a', 'warning')])).toBe('warning');
  });

  it('error dominates warning for the same node (order-independent)', () => {
    expect(nodeAnomaly('a', [issue('a', 'warning'), issue('a', 'error')])).toBe('error');
    expect(nodeAnomaly('a', [issue('a', 'error'), issue('a', 'warning')])).toBe('error');
  });

  it('ignores graph-wide issues with no nodeId', () => {
    expect(nodeAnomaly('a', [issue(undefined, 'error')])).toBeNull();
  });
});

describe('anomalyColor', () => {
  it('is a hex color for each level, and error differs from warning', () => {
    expect(anomalyColor('error')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(anomalyColor('warning')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(anomalyColor('error')).not.toBe(anomalyColor('warning'));
  });
});

describe('makeAnomalyRing', () => {
  it('is a solid (non-additive) flat ring, thicker for errors than warnings', () => {
    const err = makeAnomalyRing(55, 'error');
    const warn = makeAnomalyRing(55, 'warning');
    expect(err.rotation.x).toBeCloseTo(Math.PI / 2);
    const eg = err.geometry as THREE.TorusGeometry;
    const wg = warn.geometry as THREE.TorusGeometry;
    expect(eg.parameters.tube).toBeGreaterThan(wg.parameters.tube);
    const em = err.material as THREE.MeshBasicMaterial;
    expect(em.blending).toBe(THREE.NormalBlending); // NOT additive — palette-breaking alert
    expect(em.transparent).toBe(true);
    expect(em.depthWrite).toBe(false);
    err.geometry.dispose();
    warn.geometry.dispose();
    (err.material as THREE.Material).dispose();
    (warn.material as THREE.Material).dispose();
  });
});
