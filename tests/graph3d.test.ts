import { describe, expect, it } from 'vitest';
import { CAPSULES } from '../src/core/capsules';
import type { WorkflowNode } from '../src/core/types';
import { socketPoint } from '../src/components/graph/wires';
import {
  LIFT,
  WORLD_CENTER,
  WORLD_SCALE,
  Z_RULE,
  canvasFromWorld,
  pointerRayToPlane,
  socketWorldPoint,
  worldFromCanvas,
  worldFromNode,
  zFromNode,
  type Vec3,
} from '../src/components/graph/graph3d/projection';
import { sanitizeAppSettings, type AppSettings } from '../src/state/appSettings';

const node = (x: number, y: number): WorkflowNode => ({ id: 'n1', kind: 'sampler', x, y, params: {} });

describe('graph3d projection', () => {
  it('zFromNode recedes monotonically as x grows (gentle per-column rule)', () => {
    expect(Z_RULE).toBeGreaterThan(0);
    expect(zFromNode(0)).toBeCloseTo(0, 12);
    expect(zFromNode(100)).toBeLessThan(zFromNode(0));
    expect(zFromNode(500)).toBeLessThan(zFromNode(100));
    expect(zFromNode(240)).toBeCloseTo(-240 * Z_RULE, 10);
    // "gentle": a full column step recedes far less than a node width
    expect(Math.abs(zFromNode(240) - zFromNode(0))).toBeLessThan(240);
  });

  it('worldFromNode negates y (screen-down -> world-up) and centers on WORLD_CENTER', () => {
    const a = worldFromNode(node(100, 200), false);
    expect(a.x).toBeCloseTo((100 - WORLD_CENTER.x) * WORLD_SCALE);
    expect(a.y).toBeCloseTo(-(200 - WORLD_CENTER.y) * WORLD_SCALE);
    expect(a.z).toBeCloseTo(zFromNode(100));
    // larger screen y (lower on canvas) must be lower in the world (smaller y)
    const lower = worldFromNode(node(100, 300), false);
    expect(lower.y).toBeLessThan(a.y);
    // the canvas center maps to the world origin
    const center = worldFromCanvas(WORLD_CENTER, 0);
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0);
  });

  it('selected nodes lift toward the camera by exactly LIFT (z only)', () => {
    const idle = worldFromNode(node(320, 80), false);
    const lifted = worldFromNode(node(320, 80), true);
    expect(LIFT).toBeGreaterThan(0);
    expect(lifted.z - idle.z).toBeCloseTo(LIFT);
    expect(lifted.x).toBeCloseTo(idle.x);
    expect(lifted.y).toBeCloseTo(idle.y);
  });

  it('socketWorldPoint matches the 2D socketPoint offsets, transformed', () => {
    const n = node(300, 150);
    const outId = CAPSULES.sampler.outputs[0].id;
    const inId = CAPSULES.sampler.inputs[0].id;
    for (const [socketId, dir] of [[outId, 'out'], [inId, 'in']] as const) {
      const p2 = socketPoint(n, socketId, dir);
      const w = socketWorldPoint(n, socketId, dir, false);
      expect(w.x).toBeCloseTo((p2.x - WORLD_CENTER.x) * WORLD_SCALE);
      expect(w.y).toBeCloseTo(-(p2.y - WORLD_CENTER.y) * WORLD_SCALE);
      expect(w.z).toBeCloseTo(zFromNode(n.x));
    }
    // sockets ride the node's plane, so selection lifts them too
    const lifted = socketWorldPoint(n, outId, 'out', true);
    expect(lifted.z).toBeCloseTo(zFromNode(n.x) + LIFT);
  });

  it('pointerRayToPlane round-trips back to workflow coordinates', () => {
    const n = node(420, 260);
    const planeZ = zFromNode(n.x);
    const target = worldFromCanvas({ x: n.x, y: n.y }, planeZ);

    // ray straight down the z axis through the node's corner
    const straight = pointerRayToPlane([target.x, target.y, planeZ + 500], [0, 0, -1], planeZ);
    expect(straight).not.toBeNull();
    expect(straight!.x).toBeCloseTo(n.x, 6);
    expect(straight!.y).toBeCloseTo(n.y, 6);

    // oblique ray through the same world point (like an orbited camera)
    const origin: Vec3 = [target.x - 200, target.y + 300, planeZ + 500];
    const len = Math.hypot(target.x - origin[0], target.y - origin[1], planeZ - origin[2]);
    const dir: Vec3 = [
      (target.x - origin[0]) / len,
      (target.y - origin[1]) / len,
      (planeZ - origin[2]) / len,
    ];
    const oblique = pointerRayToPlane(origin, dir, planeZ);
    expect(oblique).not.toBeNull();
    expect(oblique!.x).toBeCloseTo(n.x, 4);
    expect(oblique!.y).toBeCloseTo(n.y, 4);
  });

  it('rejects near-parallel rays and planes behind the ray origin', () => {
    expect(pointerRayToPlane([0, 0, 100], [1, 0, 0], 0)).toBeNull();
    expect(pointerRayToPlane([0, 0, 100], [0, 1, 1e-9], 0)).toBeNull();
    // plane is behind the ray (t < 0)
    expect(pointerRayToPlane([0, 0, 100], [0, 0, 1], 0)).toBeNull();
  });

  it('canvasFromWorld inverts worldFromCanvas', () => {
    const p = { x: 987, y: -43 };
    const w = worldFromCanvas(p, 12);
    const back = canvasFromWorld(w.x, w.y);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
});

describe('appSettings graphMode', () => {
  it('is optional (old persisted state loads) and only accepts 2d/3d', () => {
    expect(sanitizeAppSettings({}).graphMode).toBeUndefined();
    expect(sanitizeAppSettings(undefined).graphMode).toBeUndefined();
    expect(sanitizeAppSettings({ graphMode: '2d' }).graphMode).toBe('2d');
    expect(sanitizeAppSettings({ graphMode: '3d' }).graphMode).toBe('3d');
    expect(sanitizeAppSettings({ graphMode: 'weird' } as unknown as Partial<AppSettings>).graphMode).toBeUndefined();
  });
});
