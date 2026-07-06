import { describe, expect, it } from 'vitest';
import { CAPSULES } from '../src/core/capsules';
import { addNode, canConnect, createDefaultWorkflow, createNode, findNode, updateNodeParam } from '../src/core/workflow';
import { nodeSummary } from '../src/components/graph/nodeSummary';
import { buildRenderJob } from '../src/bridge/adapter';

describe('img2img image node sockets', () => {
  it('imageLoader exposes an image-typed output socket', () => {
    const out = CAPSULES.imageLoader.outputs.find((s) => s.id === 'image');
    expect(out).toBeDefined();
    expect(out!.type).toBe('image');
  });

  it('sampler exposes an optional image (img2img) input socket', () => {
    const inp = CAPSULES.sampler.inputs.find((s) => s.id === 'image');
    expect(inp).toBeDefined();
    expect(inp!.type).toBe('image');
    expect(inp!.label).toBe('Image (img2img)');
  });

  it('canConnect validates imageLoader.image -> sampler.image', () => {
    let wf = createDefaultWorkflow();
    const loader = createNode('imageLoader', 0, 0);
    wf = addNode(wf, loader);
    const sampler = findNode(wf, 'sampler')!;
    const res = canConnect(wf, { node: loader.id, socket: 'image' }, { node: sampler.id, socket: 'image' });
    expect(res.ok).toBe(true);
  });
});

describe('nodeSummary for imageLoader', () => {
  it('prompts for an image when none is set', () => {
    expect(nodeSummary('imageLoader', { image: '', mask: '', strength: 0.6 })).toBe('No image — drop one here');
  });

  it('reports img2img strength when an image is set', () => {
    expect(nodeSummary('imageLoader', { image: 'data:image/png;base64,AAA', mask: '', strength: 0.6 }))
      .toBe('img2img @ 0.6');
  });

  it('mentions the mask when both image and mask are set', () => {
    expect(nodeSummary('imageLoader', { image: 'data:image/png;base64,AAA', mask: 'data:image/png;base64,BBB', strength: 0.35 }))
      .toBe('img2img @ 0.35 + mask');
  });
});

describe('presence-based img2img activation (regression guard)', () => {
  // Activation is deliberately presence-based: an uploaded image on the Load
  // Image capsule drives img2img even with NO imageLoader -> sampler edge,
  // because Recipe-view users never wire edges. The socket wire is the graph's
  // visual expression, not a gate.
  it('buildRenderJob sets initImage from imageLoader params without any edge', () => {
    let wf = createDefaultWorkflow();
    const loader = createNode('imageLoader', 0, 0);
    wf = addNode(wf, loader);
    wf = updateNodeParam(wf, loader.id, 'image', 'data:image/png;base64,AAA');
    expect(wf.edges.some((e) => e.from.node === loader.id || e.to.node === loader.id)).toBe(false);

    const job = buildRenderJob(wf);
    expect(job.initImage).toBe('data:image/png;base64,AAA');
    expect(job.denoiseStrength).toBeCloseTo(0.6);
  });

  it('buildRenderJob carries the mask too, still without edges', () => {
    let wf = createDefaultWorkflow();
    const loader = createNode('imageLoader', 0, 0);
    wf = addNode(wf, loader);
    wf = updateNodeParam(wf, loader.id, 'image', 'data:image/png;base64,AAA');
    wf = updateNodeParam(wf, loader.id, 'mask', 'data:image/png;base64,BBB');

    const job = buildRenderJob(wf);
    expect(job.initImage).toBe('data:image/png;base64,AAA');
    expect(job.maskImage).toBe('data:image/png;base64,BBB');
  });

  it('buildRenderJob leaves initImage undefined when no image is uploaded', () => {
    let wf = createDefaultWorkflow();
    wf = addNode(wf, createNode('imageLoader', 0, 0));
    const job = buildRenderJob(wf);
    expect(job.initImage).toBeUndefined();
  });
});
