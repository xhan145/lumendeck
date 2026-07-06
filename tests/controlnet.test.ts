import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRenderJob } from '../src/bridge/adapter';
import { HttpAdapter } from '../src/bridge/httpAdapter';
import {
  CONTROLNET_CAPABILITIES,
  estimateFamilyFromModelId,
  supportedTypes,
} from '../src/core/controlnet';
import { checkHealth } from '../src/core/health';
import { buildManifest } from '../src/core/manifest';
import type { ControlSlot } from '../src/core/types';
import { addNode, createDefaultWorkflow, createNode, findNode, updateNodeParam } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';
import { httpAdapter, useStudio } from '../src/state/store';
import { sanitizeBackendSettings } from '../src/turboForge/backends/backendSettings';

const slot = (type: ControlSlot['type'], over: Partial<ControlSlot> = {}): ControlSlot => ({
  id: `cn-${type}`,
  type,
  strength: 1,
  image: `data:image/png;base64,${type}AAAA`,
  enabled: true,
  ...over,
});

function withControlRack(slots: ControlSlot[]) {
  let wf = createDefaultWorkflow();
  wf = addNode(wf, createNode('controlNetRack', 0, 0));
  wf = updateNodeParam(wf, findNode(wf, 'controlNetRack')!.id, 'slots', slots);
  return wf;
}

function withLegacyControl(wf = createDefaultWorkflow()) {
  wf = addNode(wf, createNode('controlNetApply', 0, 0));
  wf = addNode(wf, createNode('imageLoader', 0, 0));
  wf = updateNodeParam(wf, findNode(wf, 'imageLoader')!.id, 'image', 'data:image/png;base64,LEGACY');
  wf = updateNodeParam(wf, findNode(wf, 'controlNetApply')!.id, 'type', 'canny');
  wf = updateNodeParam(wf, findNode(wf, 'controlNetApply')!.id, 'strength', 0.9);
  return wf;
}

describe('controlnet capability map', () => {
  it('matches the bridge capability table per family', () => {
    expect(CONTROLNET_CAPABILITIES['SD1.5']).toEqual([
      'canny', 'depth', 'pose', 'scribble', 'lineart', 'softedge', 'tile',
    ]);
    expect(CONTROLNET_CAPABILITIES['SD2.1']).toEqual(['canny', 'depth', 'pose']);
    expect(CONTROLNET_CAPABILITIES.SDXL).toEqual(['canny', 'depth', 'pose', 'scribble', 'tile']);
  });

  it('estimates the family from a model id (xl wins first)', () => {
    expect(estimateFamilyFromModelId('ckpt-lumen-xl')).toBe('SDXL');
    expect(estimateFamilyFromModelId('SDXL-turbo')).toBe('SDXL');
    expect(estimateFamilyFromModelId('stabilityai/sd-turbo')).toBe('SD2.1');
    expect(estimateFamilyFromModelId('sd2-1-base')).toBe('SD2.1');
    expect(estimateFamilyFromModelId('stable-diffusion-v2')).toBe('SD2.1');
    expect(estimateFamilyFromModelId('ckpt-drift-15')).toBe('SD1.5');
    expect(estimateFamilyFromModelId('')).toBe('SD1.5');
  });

  it('supportedTypes reads the capability table', () => {
    expect(supportedTypes('SD2.1')).toEqual(['canny', 'depth', 'pose']);
    expect(supportedTypes('SDXL')).not.toContain('lineart');
    expect(supportedTypes('SD1.5')).toHaveLength(7);
  });
});

describe('buildRenderJob controlNets', () => {
  it('collects enabled rack slots with images and mirrors the first into controlNet', () => {
    const wf = withControlRack([
      slot('depth', { strength: 0.8 }),
      slot('pose', { strength: 1.2 }),
      slot('canny', { enabled: false }),
      slot('tile', { image: '' }),
    ]);

    const job = buildRenderJob(wf);

    expect(job.controlNets).toEqual([
      { model: 'depth', strength: 0.8, image: 'data:image/png;base64,depthAAAA' },
      { model: 'pose', strength: 1.2, image: 'data:image/png;base64,poseAAAA' },
    ]);
    expect(job.controlNet).toEqual(job.controlNets![0]);
  });

  it('appends the legacy controlNetApply + Load Image entry after rack slots', () => {
    const wf = withLegacyControl(withControlRack([slot('depth', { strength: 0.8 })]));

    const job = buildRenderJob(wf);

    expect(job.controlNets).toHaveLength(2);
    expect(job.controlNets![1]).toEqual({ model: 'canny', strength: 0.9, image: 'data:image/png;base64,LEGACY' });
    expect(job.controlNet).toEqual({ model: 'depth', strength: 0.8, image: 'data:image/png;base64,depthAAAA' });
  });

  it('keeps the legacy singular path working without a rack', () => {
    const job = buildRenderJob(withLegacyControl());

    expect(job.controlNet).toEqual({ model: 'canny', strength: 0.9, image: 'data:image/png;base64,LEGACY' });
    expect(job.controlNets).toEqual([job.controlNet]);
  });

  it('leaves controlNet and controlNets undefined when no controls are present', () => {
    const job = buildRenderJob(createDefaultWorkflow());
    expect(job.controlNet).toBeUndefined();
    expect(job.controlNets).toBeUndefined();
  });
});

describe('controlnet health rules', () => {
  const codes = (wf: ReturnType<typeof createDefaultWorkflow>) =>
    checkHealth(wf, DEMO_SHELF).map((i) => i.code);

  function sdxlModel(wf: ReturnType<typeof createDefaultWorkflow>) {
    return updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-lumen-xl');
  }

  it('warns when an enabled slot type is unsupported by the model family', () => {
    const wf = sdxlModel(withControlRack([slot('lineart')]));
    const issues = checkHealth(wf, DEMO_SHELF);
    const issue = issues.find((i) => i.code === 'controlnet-compat');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('Lineart is not available for this model');
    expect(issue?.message).toContain('it will be skipped');
  });

  it('does not warn for supported types or disabled slots', () => {
    const supportedWf = sdxlModel(withControlRack([slot('canny'), slot('depth')]));
    expect(codes(supportedWf)).not.toContain('controlnet-compat');

    const disabledWf = sdxlModel(withControlRack([slot('lineart', { enabled: false })]));
    expect(codes(disabledWf)).not.toContain('controlnet-compat');
  });

  it('warns about 3+ enabled control slots but not 2', () => {
    const heavy = sdxlModel(withControlRack([slot('canny'), slot('depth'), slot('pose')]));
    const issue = checkHealth(heavy, DEMO_SHELF).find((i) => i.code === 'controlnet-stack');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('heavy on 8 GB GPUs');

    const light = sdxlModel(withControlRack([slot('canny'), slot('depth')]));
    expect(codes(light)).not.toContain('controlnet-stack');
  });
});

describe('manifest controlNets', () => {
  it('records type and strength for rack slots plus the legacy entry', () => {
    let wf = withControlRack([
      slot('depth', { strength: 0.8 }),
      slot('pose', { enabled: false }),
    ]);
    wf = withLegacyControl(wf);

    const m = buildManifest(wf, DEMO_SHELF, '0.1.0', new Date('2026-07-06T12:00:00Z'));

    expect(m.controlNets).toEqual([
      { type: 'depth', strength: 0.8 },
      { type: 'canny', strength: 0.9 },
    ]);
  });

  it('records an empty list when no controls are used', () => {
    const m = buildManifest(createDefaultWorkflow(), DEMO_SHELF, '0.1.0', new Date());
    expect(m.controlNets).toEqual([]);
  });
});

describe('droppedControls surfacing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('http adapter maps droppedControls from the bridge response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      image_base64: 'abc',
      seed: 5,
      droppedControls: [{ type: 'depth', reason: 'no SD2.1 model' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new HttpAdapter('http://bridge.local');
    const result = await adapter.generate(buildRenderJob(createDefaultWorkflow()));

    expect(result.droppedControls).toEqual([{ type: 'depth', reason: 'no SD2.1 model' }]);
  });

  it('store surfaces droppedControls as a queue warning banner', async () => {
    useStudio.getState().resetWorkflow();
    const model = findNode(useStudio.getState().workflow, 'model')!;
    useStudio.getState().updateParam(model.id, 'assetId', 'ckpt-lumen-xl');
    useStudio.setState({
      backendSettings: sanitizeBackendSettings({
        selectedBackend: 'bridge',
        bridgeUrl: 'http://bridge.local',
        bridgeRenderer: 'diffusers',
        fallbackToMock: false,
      }),
      adapterId: 'bridge',
      queue: [],
      queuePaused: false,
    });
    vi.spyOn(httpAdapter, 'generate').mockResolvedValue({
      dataUrl: 'data:image/png;base64,abc',
      mediaType: 'image',
      mimeType: 'image/png',
      extension: 'png',
      seed: 42,
      droppedControls: [{ type: 'depth', reason: 'no SD2.1 model' }],
    });

    await useStudio.getState().enqueueRender();

    const job = useStudio.getState().queue[0];
    expect(job.status).toBe('done_with_warning');
    expect(job.warning).toBe('Skipped controls: depth (no SD2.1 model)');
    expect(job.fallback).toBeFalsy();
  });
});
