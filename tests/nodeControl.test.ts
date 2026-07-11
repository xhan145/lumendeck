import { describe, it, expect } from 'vitest';
import { packWells } from '../src/components/graph/graph3d/fabric';
import { setNodeDepth, createNode } from '../src/core/workflow';
import { nodeDepth } from '../src/components/graph/graph3d/nodeSpace';
import { orbWorldCenter } from '../src/components/graph/graph3d/projection';
import type { WorkflowNode, Workflow } from '../src/core/types';

const wf = (nodes: WorkflowNode[]): Workflow => ({
  id: 'test', name: 'test', version: 1, schemaVersion: 1, nodes, edges: [],
});

/** A sampler at a given canvas y (controls world height) with a fixed weight. */
function sampler(id: string, y: number, z?: number): WorkflowNode {
  return { id, kind: 'sampler', x: 0, y, params: { cfg: 15 }, ...(z !== undefined ? { z } : {}) };
}

describe('packWells height → mass', () => {
  it('a lifted node produces a deeper AND wider well than one at the neutral reference', () => {
    // orbWorldCenter maps canvas y -> world y = -(y + ORB_RADIUS - 360). A small
    // canvas y sits HIGH in the world (more mass); a large y sits low.
    const high = sampler('high', 0); // high in the world -> lifted -> more mass
    const neutralY = 360 - 55; // ~ world y 0 (ORB_RADIUS = 55) -> neutral
    const neutral = sampler('mid', neutralY);
    const wHigh = packWells([high]).wells[0];
    const wNeutral = packWells([neutral]).wells[0];
    expect(orbWorldCenter(high).y).toBeGreaterThan(orbWorldCenter(neutral).y);
    expect(wHigh.depth).toBeGreaterThan(wNeutral.depth);
    expect(wHigh.sigma).toBeGreaterThan(wNeutral.sigma);
  });

  it('a node at the neutral reference matches the pre-feature well (regression guard)', () => {
    const neutralY = 360 - 55; // world y ~ 0 -> mass ×1
    const w = packWells([sampler('n', neutralY)]).wells[0];
    // DEPTH_SCALE 150, weightT(sampler cfg 15) over 0..30 -> 0.5 -> depth 75.
    expect(w.depth).toBeCloseTo(75, 1);
  });

  it('honors explicit depth (z) in the well position', () => {
    const w = packWells([sampler('z', 200, 999)]).wells[0];
    expect(w.z).toBe(999); // orbWorldCenter uses nodeDepth -> explicit z
  });
});

describe('setNodeDepth (workflow helper)', () => {
  const base = wf([createNode('sampler', 10, 20)]);

  it('sets an explicit z and bumps the workflow', () => {
    const id = base.nodes[0].id;
    const next = setNodeDepth(base, id, 250);
    expect(next.nodes[0].z).toBe(250);
    expect(next).not.toBe(base); // new reference (committed)
    expect(nodeDepth(next.nodes[0])).toBe(250);
  });

  it('clears z when passed a non-finite value (reverts to derived depth)', () => {
    const id = base.nodes[0].id;
    const withZ = setNodeDepth(base, id, 250);
    const cleared = setNodeDepth(withZ, id, Number.NaN);
    expect(cleared.nodes[0].z).toBeUndefined();
    expect(nodeDepth(cleared.nodes[0])).toBe(nodeDepth({ x: 10 })); // back to zFromNode(x)
  });

  it('preserves the reference of unchanged nodes (nodeMeta diff stays tight)', () => {
    const w = wf([createNode('sampler', 0, 0), createNode('prompt', 100, 0)]);
    const next = setNodeDepth(w, w.nodes[0].id, 40);
    expect(next.nodes[1]).toBe(w.nodes[1]); // the other node's ref is untouched
  });
});
