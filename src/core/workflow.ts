import { CAPSULES, defaultParams } from './capsules';
import type { CapsuleKind, SocketRef, SocketType, Workflow, WorkflowEdge, WorkflowNode } from './types';

let counter = 0;
/** Collision-free enough for a local document; stable across reloads via persistence. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createNode(kind: CapsuleKind, x: number, y: number): WorkflowNode {
  return { id: uid(kind), kind, x, y, params: defaultParams(kind) };
}

function bump(wf: Workflow, patch: Partial<Workflow>): Workflow {
  return { ...wf, ...patch, version: wf.version + 1 };
}

export function addNode(wf: Workflow, node: WorkflowNode): Workflow {
  return bump(wf, { nodes: [...wf.nodes, node] });
}

export function duplicateNode(wf: Workflow, nodeId: string, dx = 32, dy = 32): Workflow {
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (!node) return wf;
  const copy: WorkflowNode = {
    ...node,
    id: uid(node.kind),
    x: node.x + dx,
    y: node.y + dy,
    params: JSON.parse(JSON.stringify(node.params)),
  };
  return addNode(wf, copy);
}

export function autoLayout(wf: Workflow): Workflow {
  const lanes: Record<CapsuleKind, { x: number; y: number }> = {
    prompt: { x: 40, y: 60 },
    model: { x: 40, y: 320 },
    loraRack: { x: 330, y: 320 },
    control: { x: 40, y: 580 },
    canvas: { x: 330, y: 580 },
    sampler: { x: 620, y: 240 },
    video: { x: 910, y: 240 },
    queue: { x: 1200, y: 240 },
    export: { x: 1490, y: 240 },
    manifest: { x: 1490, y: 500 },
  };
  const seen = new Map<CapsuleKind, number>();
  return bump(wf, {
    nodes: wf.nodes.map((node) => {
      const base = lanes[node.kind];
      const count = seen.get(node.kind) ?? 0;
      seen.set(node.kind, count + 1);
      return { ...node, x: base.x, y: base.y + count * 150 };
    }),
  });
}

export function removeNode(wf: Workflow, nodeId: string): Workflow {
  return bump(wf, {
    nodes: wf.nodes.filter((n) => n.id !== nodeId),
    edges: wf.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId),
  });
}

export function moveNode(wf: Workflow, nodeId: string, x: number, y: number): Workflow {
  return bump(wf, {
    nodes: wf.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)),
  });
}

export function updateNodeParam(wf: Workflow, nodeId: string, paramId: string, value: unknown): Workflow {
  return bump(wf, {
    nodes: wf.nodes.map((n) =>
      n.id === nodeId ? { ...n, params: { ...n.params, [paramId]: value } } : n,
    ),
  });
}

function socketDef(wf: Workflow, ref: SocketRef, dir: 'in' | 'out') {
  const node = wf.nodes.find((n) => n.id === ref.node);
  if (!node) return undefined;
  const def = CAPSULES[node.kind];
  const list = dir === 'out' ? def.outputs : def.inputs;
  return list.find((s) => s.id === ref.socket);
}

function socketTypesCompatible(out: SocketType, input: SocketType): boolean {
  return out === input || (input === 'media' && (out === 'image' || out === 'media'));
}

/** Would adding an edge from→to create a cycle? */
function createsCycle(wf: Workflow, from: SocketRef, to: SocketRef): boolean {
  const adj = new Map<string, string[]>();
  for (const e of [...wf.edges, { id: '', from, to }]) {
    const list = adj.get(e.from.node) ?? [];
    list.push(e.to.node);
    adj.set(e.from.node, list);
  }
  const seen = new Set<string>();
  const stack = [to.node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from.node) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}

export function canConnect(wf: Workflow, from: SocketRef, to: SocketRef): { ok: boolean; reason?: string } {
  if (from.node === to.node) return { ok: false, reason: 'Cannot connect a capsule to itself.' };
  const out = socketDef(wf, from, 'out');
  const inp = socketDef(wf, to, 'in');
  if (!out || !inp) return { ok: false, reason: 'Socket not found.' };
  if (!socketTypesCompatible(out.type, inp.type)) {
    return { ok: false, reason: `Type mismatch: ${out.type} output cannot feed a ${inp.type} input.` };
  }
  if (createsCycle(wf, from, to)) return { ok: false, reason: 'Connection would create a cycle.' };
  return { ok: true };
}

/** Connect, replacing any existing edge into the target input socket. */
export function connect(wf: Workflow, from: SocketRef, to: SocketRef): Workflow {
  const check = canConnect(wf, from, to);
  if (!check.ok) return wf;
  const edge: WorkflowEdge = { id: uid('edge'), from, to };
  return bump(wf, {
    edges: [...wf.edges.filter((e) => !(e.to.node === to.node && e.to.socket === to.socket)), edge],
  });
}

export function disconnect(wf: Workflow, edgeId: string): Workflow {
  return bump(wf, { edges: wf.edges.filter((e) => e.id !== edgeId) });
}

export function findNode(wf: Workflow, kind: CapsuleKind): WorkflowNode | undefined {
  return wf.nodes.find((n) => n.kind === kind);
}

/** Default studio workflow: all core capsules pre-wired left to right. */
export function createDefaultWorkflow(): Workflow {
  const prompt = createNode('prompt', 40, 60);
  const model = createNode('model', 40, 320);
  const rack = createNode('loraRack', 330, 320);
  const control = createNode('control', 40, 560);
  const canvas = createNode('canvas', 330, 560);
  const sampler = createNode('sampler', 620, 220);
  const video = createNode('video', 910, 220);
  const queue = createNode('queue', 1200, 220);
  const exportN = createNode('export', 1490, 220);
  const manifest = createNode('manifest', 1490, 470);

  let wf: Workflow = {
    id: uid('wf'),
    name: 'Untitled recipe',
    version: 0,
    schemaVersion: 1,
    nodes: [prompt, model, rack, control, canvas, sampler, video, queue, exportN, manifest],
    edges: [],
  };
  wf = connect(wf, { node: prompt.id, socket: 'conditioning' }, { node: sampler.id, socket: 'conditioning' });
  wf = connect(wf, { node: model.id, socket: 'model' }, { node: rack.id, socket: 'model_in' });
  wf = connect(wf, { node: rack.id, socket: 'model_out' }, { node: sampler.id, socket: 'model' });
  wf = connect(wf, { node: control.id, socket: 'control' }, { node: sampler.id, socket: 'control' });
  wf = connect(wf, { node: canvas.id, socket: 'latent' }, { node: sampler.id, socket: 'latent' });
  wf = connect(wf, { node: sampler.id, socket: 'image' }, { node: video.id, socket: 'image' });
  wf = connect(wf, { node: video.id, socket: 'media' }, { node: queue.id, socket: 'media' });
  wf = connect(wf, { node: queue.id, socket: 'media_out' }, { node: exportN.id, socket: 'media' });
  wf = connect(wf, { node: exportN.id, socket: 'manifest_out' }, { node: manifest.id, socket: 'manifest_in' });
  return { ...wf, version: 1 };
}
