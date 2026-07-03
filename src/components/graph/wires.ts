import { CAPSULES } from '../../core/capsules';
import type { SocketType, Workflow, WorkflowNode } from '../../core/types';

export const NODE_WIDTH = 240;
export const HEAD_HEIGHT = 37;
export const ROW_HEIGHT = 24;
export const BODY_PAD = 6;

/** Local (node-relative) y-center of an input or output socket row. */
export function socketOffsetY(node: WorkflowNode, socketId: string, dir: 'in' | 'out'): number {
  const def = CAPSULES[node.kind];
  const list = dir === 'in' ? def.inputs : def.outputs;
  const index = list.findIndex((s) => s.id === socketId);
  const base = HEAD_HEIGHT + BODY_PAD + ROW_HEIGHT / 2;
  return base + Math.max(0, index) * ROW_HEIGHT;
}

export interface Point { x: number; y: number; }

/** Absolute canvas coordinates of a socket anchor. */
export function socketPoint(node: WorkflowNode, socketId: string, dir: 'in' | 'out'): Point {
  return {
    x: dir === 'in' ? node.x : node.x + NODE_WIDTH,
    y: node.y + socketOffsetY(node, socketId, dir),
  };
}

/** Cubic bezier path with horizontal control handles for a smooth wire. */
export function wirePath(from: Point, to: Point): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

export function socketColor(type: SocketType): string {
  return `var(--sock-${type})`;
}

export function edgeEndpoints(wf: Workflow, edgeFrom: { node: string; socket: string }, edgeTo: { node: string; socket: string }) {
  const fromNode = wf.nodes.find((n) => n.id === edgeFrom.node);
  const toNode = wf.nodes.find((n) => n.id === edgeTo.node);
  if (!fromNode || !toNode) return null;
  return {
    from: socketPoint(fromNode, edgeFrom.socket, 'out'),
    to: socketPoint(toNode, edgeTo.socket, 'in'),
  };
}
