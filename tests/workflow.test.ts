import { describe, expect, it } from 'vitest';
import {
  addNode,
  autoLayout,
  canConnect,
  connect,
  createDefaultWorkflow,
  createNode,
  disconnect,
  duplicateNode,
  findNode,
  moveNode,
  removeNode,
  updateNodeParam,
} from '../src/core/workflow';

describe('default workflow', () => {
  it('contains all core capsules fully wired', () => {
    const wf = createDefaultWorkflow();
    expect(wf.nodes).toHaveLength(10);
    expect(wf.edges).toHaveLength(9);
    expect(wf.schemaVersion).toBe(1);
  });
});

describe('workflow ops', () => {
  it('updateNodeParam is immutable and bumps version', () => {
    const wf = createDefaultWorkflow();
    const prompt = findNode(wf, 'prompt')!;
    const next = updateNodeParam(wf, prompt.id, 'positive', 'hello');
    expect(next).not.toBe(wf);
    expect(next.version).toBe(wf.version + 1);
    expect(findNode(next, 'prompt')!.params.positive).toBe('hello');
    expect(findNode(wf, 'prompt')!.params.positive).not.toBe('hello');
  });

  it('removeNode drops attached edges', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const next = removeNode(wf, sampler.id);
    expect(next.nodes.find((n) => n.id === sampler.id)).toBeUndefined();
    expect(next.edges.some((e) => e.from.node === sampler.id || e.to.node === sampler.id)).toBe(false);
  });

  it('moveNode updates coordinates', () => {
    const wf = createDefaultWorkflow();
    const prompt = findNode(wf, 'prompt')!;
    const next = moveNode(wf, prompt.id, 500, 501);
    expect(findNode(next, 'prompt')).toMatchObject({ x: 500, y: 501 });
  });

  it('duplicateNode copies params without copying edges', () => {
    let wf = createDefaultWorkflow();
    const prompt = findNode(wf, 'prompt')!;
    wf = updateNodeParam(wf, prompt.id, 'positive', 'copy me');
    const next = duplicateNode(wf, prompt.id);
    const prompts = next.nodes.filter((n) => n.kind === 'prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].params.positive).toBe('copy me');
    expect(next.edges.filter((edge) => edge.from.node === prompts[1].id || edge.to.node === prompts[1].id)).toHaveLength(0);
  });

  it('autoLayout gives duplicate node kinds stable lanes', () => {
    let wf = createDefaultWorkflow();
    wf = duplicateNode(wf, findNode(wf, 'prompt')!.id);
    const next = autoLayout(wf);
    const prompts = next.nodes.filter((n) => n.kind === 'prompt');
    expect(prompts[0].x).toBe(40);
    expect(prompts[1].x).toBe(40);
    expect(prompts[1].y).toBeGreaterThan(prompts[0].y);
  });
});

describe('canConnect', () => {
  it('rejects type mismatches with a reason', () => {
    const wf = createDefaultWorkflow();
    const prompt = findNode(wf, 'prompt')!;
    const rack = findNode(wf, 'loraRack')!;
    const res = canConnect(
      wf,
      { node: prompt.id, socket: 'conditioning' },
      { node: rack.id, socket: 'model_in' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/mismatch/i);
  });

  it('rejects self-connections and cycles', () => {
    let wf = createDefaultWorkflow();
    const queue = findNode(wf, 'queue')!;
    expect(canConnect(wf, { node: queue.id, socket: 'media_out' }, { node: queue.id, socket: 'media' }).ok).toBe(false);

    // queue.image_out already flows to export; sampler → queue exists.
    // Wiring queue back into sampler's latent input is a type mismatch, so
    // build an explicit cycle with two image-typed nodes instead:
    const q2 = createNode('queue', 0, 0);
    wf = addNode(wf, q2);
    wf = connect(wf, { node: queue.id, socket: 'media_out' }, { node: q2.id, socket: 'media' });
    const back = canConnect(wf, { node: q2.id, socket: 'media_out' }, { node: queue.id, socket: 'media' });
    expect(back.ok).toBe(false);
    expect(back.reason).toMatch(/cycle/i);
  });

  it('allows image outputs to feed media inputs', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const queue = findNode(wf, 'queue')!;
    const res = canConnect(wf, { node: sampler.id, socket: 'image' }, { node: queue.id, socket: 'media' });
    expect(res.ok).toBe(true);
  });

  it('connect replaces the existing edge on an input socket', () => {
    let wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const model = findNode(wf, 'model')!;
    const rackEdge = wf.edges.find((e) => e.to.node === sampler.id && e.to.socket === 'model')!;
    // wire model directly into rack input again (replace) — same socket types
    const rack = findNode(wf, 'loraRack')!;
    const before = wf.edges.filter((e) => e.to.node === rack.id && e.to.socket === 'model_in');
    expect(before).toHaveLength(1);
    wf = connect(wf, { node: model.id, socket: 'model' }, { node: rack.id, socket: 'model_in' });
    const after = wf.edges.filter((e) => e.to.node === rack.id && e.to.socket === 'model_in');
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(before[0].id);
    expect(rackEdge).toBeDefined();
  });

  it('disconnect removes an edge', () => {
    const wf = createDefaultWorkflow();
    const edge = wf.edges[0];
    const next = disconnect(wf, edge.id);
    expect(next.edges).toHaveLength(wf.edges.length - 1);
  });
});
