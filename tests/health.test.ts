import { describe, expect, it } from 'vitest';
import { checkHealth, estimateVramGB } from '../src/core/health';
import type { LoraSlot, Workflow } from '../src/core/types';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';

function healthyWorkflow(): Workflow {
  let wf = createDefaultWorkflow();
  wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-lumen-xl');
  return wf;
}

const codes = (wf: Workflow) => checkHealth(wf, DEMO_SHELF).map((i) => i.code);

describe('checkHealth', () => {
  it('reports no errors for the healthy default', () => {
    const issues = checkHealth(healthyWorkflow(), DEMO_SHELF);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('flags a missing checkpoint selection', () => {
    const wf = createDefaultWorkflow(); // no assetId chosen
    expect(codes(wf)).toContain('missing-model');
  });

  it('flags a checkpoint that is not installed', () => {
    let wf = healthyWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-sd3-nova');
    expect(codes(wf)).toContain('model-not-installed');
  });

  it('flags an unknown checkpoint id', () => {
    let wf = healthyWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-ghost');
    expect(codes(wf)).toContain('missing-model');
  });

  it('flags broken links referencing removed nodes', () => {
    const wf = healthyWorkflow();
    const broken: Workflow = {
      ...wf,
      edges: [...wf.edges, { id: 'zombie', from: { node: 'ghost', socket: 'x' }, to: { node: 'ghost2', socket: 'y' } }],
    };
    expect(codes(broken)).toContain('broken-link');
  });

  it('flags socket type mismatches present in a document', () => {
    const wf = healthyWorkflow();
    const prompt = findNode(wf, 'prompt')!;
    const rack = findNode(wf, 'loraRack')!;
    const bad: Workflow = {
      ...wf,
      edges: [
        ...wf.edges,
        { id: 'bad', from: { node: prompt.id, socket: 'conditioning' }, to: { node: rack.id, socket: 'model_in' } },
      ],
    };
    expect(codes(bad)).toContain('socket-mismatch');
  });

  it('flags non-multiple-of-8 dimensions as errors', () => {
    let wf = healthyWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'canvas')!.id, 'width', 1023);
    const issues = checkHealth(wf, DEMO_SHELF);
    const dim = issues.find((i) => i.code === 'bad-dimensions');
    expect(dim?.severity).toBe('error');
  });

  it('flags VRAM risk for huge canvases', () => {
    let wf = healthyWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'canvas')!.id, 'width', 2048);
    wf = updateNodeParam(wf, findNode(wf, 'canvas')!.id, 'height', 2048);
    expect(codes(wf)).toContain('vram-risk');
  });

  it('flags cross-family LoRA usage', () => {
    let wf = healthyWorkflow(); // SDXL checkpoint
    const slots: LoraSlot[] = [{ assetId: 'lora-retro-grain', weight: 0.8, enabled: true }]; // SD1.5
    wf = updateNodeParam(wf, findNode(wf, 'loraRack')!.id, 'slots', slots);
    expect(codes(wf)).toContain('lora-compat');
  });

  it('flags a sampler with no model input', () => {
    let wf = healthyWorkflow();
    const edge = wf.edges.find((e) => e.to.socket === 'model')!;
    wf = { ...wf, edges: wf.edges.filter((e) => e.id !== edge.id) };
    expect(codes(wf)).toContain('disconnected');
  });
});

describe('estimateVramGB', () => {
  it('scales with resolution, batch and family', () => {
    expect(estimateVramGB(512, 512, 1, 'SD1.5')).toBeLessThan(estimateVramGB(1024, 1024, 1, 'SD1.5'));
    expect(estimateVramGB(1024, 1024, 1, 'SDXL')).toBeLessThan(estimateVramGB(1024, 1024, 4, 'SDXL'));
    expect(estimateVramGB(1024, 1024, 1, 'Flux')).toBeGreaterThan(estimateVramGB(1024, 1024, 1, 'SD1.5'));
  });
});
