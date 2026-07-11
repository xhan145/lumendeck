import { describe, it, expect } from 'vitest';
import type { BufferAttribute } from 'three';
import {
  bezierPoint,
  pulseCountFor,
  advancePulse,
  createEnergyFlow,
  MAX_PULSES,
  type FlowEdge,
} from '../src/components/graph/graph3d/energyFlow';
import { wireControl } from '../src/components/graph/graph3d/scene';

const edge = (id: string, over?: Partial<FlowEdge>): FlowEdge => ({
  id,
  ax: 0, ay: 0, az: 0,
  cx: 50, cy: 50, cz: 40,
  bx: 100, by: 100, bz: 0,
  color: '#34d6f4',
  activity: 0,
  blocked: false,
  ...over,
});

describe('bezierPoint', () => {
  it('hits the endpoints at t=0 and t=1', () => {
    const p0 = bezierPoint(1, 2, 3, 50, 60, 70, 9, 8, 7, 0);
    expect([p0.x, p0.y, p0.z]).toEqual([1, 2, 3]);
    const p1 = bezierPoint(1, 2, 3, 50, 60, 70, 9, 8, 7, 1);
    expect([p1.x, p1.y, p1.z]).toEqual([9, 8, 7]);
  });

  it('bows toward the control point at the middle', () => {
    const mid = bezierPoint(0, 0, 0, 50, 100, 0, 100, 0, 0, 0.5);
    expect(mid.y).toBeGreaterThan(0); // pulled up by the control
    expect(mid.y).toBeLessThan(100); // but never reaches it
  });

  it('matches the rendered wire: control from scene.wireControl', () => {
    const a = { x: 0, y: 10, z: 5 };
    const b = { x: 200, y: -10, z: 25 };
    const c = wireControl(a, b);
    expect(c.x).toBe(100);
    expect(c.y).toBe(0);
    expect(c.z).toBeGreaterThan(Math.max(a.z, b.z)); // bows toward the camera
  });
});

describe('pulseCountFor', () => {
  it('base pulses at zero activity, more when the endpoints are hot', () => {
    expect(pulseCountFor(0, 2)).toBe(2);
    expect(pulseCountFor(1, 2)).toBe(4);
    expect(pulseCountFor(0.5, 2)).toBe(3);
  });

  it('zero base = layer disabled regardless of activity', () => {
    expect(pulseCountFor(1, 0)).toBe(0);
  });

  it('clamps out-of-range activity', () => {
    expect(pulseCountFor(9, 2)).toBe(4);
    expect(pulseCountFor(-3, 2)).toBe(2);
  });
});

describe('advancePulse', () => {
  it('moves forward and wraps in [0,1)', () => {
    let t = 0.9;
    for (let i = 0; i < 100; i++) {
      const next = advancePulse(t, 0.05, 0, false);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(1);
      t = next;
    }
  });

  it('activity speeds pulses up; blocked edges crawl', () => {
    const idle = advancePulse(0, 0.05, 0, false);
    const hot = advancePulse(0, 0.05, 1, false);
    const blocked = advancePulse(0, 0.05, 0, true);
    expect(hot).toBeGreaterThan(idle);
    expect(blocked).toBeLessThan(idle);
  });
});

describe('createEnergyFlow', () => {
  it('assigns deterministic pulses per edge and reports active()', () => {
    const flow = createEnergyFlow();
    expect(flow.active()).toBe(false);
    const dropped = flow.setEdges([edge('e1'), edge('e2', { activity: 1 })], 2);
    expect(dropped).toBe(0);
    expect(flow.active()).toBe(true);
    // e1 idle → 2 pulses; e2 hot → 4 pulses.
    expect(flow.points.geometry.drawRange.count).toBe(6);
    flow.dispose();
  });

  it('advance moves every pulse along its curve (positions land on the wire span)', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('e1')], 2);
    flow.advance(0.016);
    const pos = flow.points.geometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < flow.points.geometry.drawRange.count; i++) {
      expect(arr[i * 3]).toBeGreaterThanOrEqual(0);
      expect(arr[i * 3]).toBeLessThanOrEqual(100);
      expect(Number.isFinite(arr[i * 3 + 1])).toBe(true);
    }
    flow.dispose();
  });

  it('preserves in-flight pulse phases across a setEdges rebuild (no teleport on re-commit)', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('e1'), edge('e2')], 3);
    // Fly the pulses well away from their seed phase.
    for (let i = 0; i < 40; i++) flow.advance(0.05);
    const posAttr = flow.points.geometry.getAttribute('position') as BufferAttribute;
    const n = flow.points.geometry.drawRange.count;
    const before = Array.from((posAttr.array as Float32Array).slice(0, n * 3));
    // A re-commit with the SAME edges (what a node select / activity tick does)
    // must NOT reset the phases: one negligible advance should land the pulses
    // essentially where they already were, not back at their hashed seed.
    flow.setEdges([edge('e1'), edge('e2')], 3);
    flow.advance(1e-6);
    const after = Array.from((posAttr.array as Float32Array).slice(0, n * 3));
    for (let i = 0; i < after.length; i++) expect(after[i]).toBeCloseTo(before[i], 2);
    flow.dispose();
  });

  it('seeds only genuinely new pulses when activity rises (existing ones keep their phase)', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('e1', { activity: 0 })], 2); // 2 pulses
    for (let i = 0; i < 30; i++) flow.advance(0.05);
    const posAttr = flow.points.geometry.getAttribute('position') as BufferAttribute;
    const first2 = Array.from((posAttr.array as Float32Array).slice(0, 6));
    flow.setEdges([edge('e1', { activity: 1 })], 2); // now 4 pulses; first 2 carry over
    flow.advance(1e-6);
    const after = Array.from((posAttr.array as Float32Array).slice(0, 6));
    for (let i = 0; i < 6; i++) expect(after[i]).toBeCloseTo(first2[i], 2);
    expect(flow.points.geometry.drawRange.count).toBe(4);
    flow.dispose();
  });

  it('two flows with the same edges animate identically (deterministic phases)', () => {
    const a = createEnergyFlow();
    const b = createEnergyFlow();
    a.setEdges([edge('e1'), edge('e2')], 3);
    b.setEdges([edge('e1'), edge('e2')], 3);
    for (let i = 0; i < 10; i++) {
      a.advance(0.016);
      b.advance(0.016);
    }
    const pa = a.points.geometry.getAttribute('position').array as Float32Array;
    const pb = b.points.geometry.getAttribute('position').array as Float32Array;
    expect(Array.from(pa)).toEqual(Array.from(pb));
    a.dispose();
    b.dispose();
  });

  it('blocked edges dim their pulses (energy attribute drops)', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('ok'), edge('bad', { blocked: true })], 1);
    flow.advance(0.016);
    const e = flow.points.geometry.getAttribute('aEnergy').array as Float32Array;
    expect(e[1]).toBeLessThan(e[0]); // blocked pulse is dimmer than the healthy one
    flow.dispose();
  });

  it('updateGeometry moves an edge curve in place (playback rerouting)', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('e1')], 1);
    flow.updateGeometry('e1', 1000, 0, 0, 1050, 0, 0, 1100, 0, 0);
    flow.advance(0.016);
    const arr = flow.points.geometry.getAttribute('position').array as Float32Array;
    expect(arr[0]).toBeGreaterThanOrEqual(1000);
    expect(arr[0]).toBeLessThanOrEqual(1100);
    flow.dispose();
  });

  it('caps pulses at MAX_PULSES and reports dropped edges (no silent caps)', () => {
    const flow = createEnergyFlow();
    const edges: FlowEdge[] = [];
    for (let i = 0; i < 200; i++) edges.push(edge(`e${i}`, { activity: 1 })); // 4 pulses each
    const dropped = flow.setEdges(edges, 2);
    expect(dropped).toBeGreaterThan(0);
    expect(flow.points.geometry.drawRange.count).toBeLessThanOrEqual(MAX_PULSES);
    flow.dispose();
  });

  it('huge deltas clamp (tab restore never teleports pulses)', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('e1')], 1);
    flow.advance(0.016);
    const before = (flow.points.geometry.getAttribute('position').array as Float32Array)[0];
    flow.advance(60); // one "minute-long" frame
    const after = (flow.points.geometry.getAttribute('position').array as Float32Array)[0];
    // 50ms clamped step at idle speed moves ~1.5% of the wire, not 18 laps.
    expect(Math.abs(after - before)).toBeLessThan(10);
    flow.dispose();
  });

  it('dispose is idempotent', () => {
    const flow = createEnergyFlow();
    flow.setEdges([edge('e1')], 2);
    expect(() => {
      flow.dispose();
      flow.dispose();
    }).not.toThrow();
  });
});
