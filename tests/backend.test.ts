import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRenderJob } from '../src/bridge/adapter';
import { ComfyAdapter } from '../src/bridge/comfyAdapter';
import { buildStreamingPreview } from '../src/bridge/preview';
import { buildManifest } from '../src/core/manifest';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';
import { loadPersisted, savePersisted } from '../src/state/persistence';
import { httpAdapter, useStudio } from '../src/state/store';
import { sanitizeBackendSettings, settingsBackendToTurboBackend } from '../src/turboForge/backends/backendSettings';
import { withTurboForgeManifest } from '../src/turboForge/manifest';
import { buildCapabilityMatrix } from '../src/turboForge/modelMatrix';
import { createRenderPlan } from '../src/turboForge/renderPlanner';
import { BASIC_TXT2IMG_TEMPLATE } from '../src/turboForge/workflows/comfyWorkflowTemplates';
import { mapComfyTemplate } from '../src/turboForge/workflows/templateMapper';

function wfWithModel() {
  let wf = createDefaultWorkflow();
  wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-lumen-xl');
  wf = updateNodeParam(wf, findNode(wf, 'prompt')!.id, 'positive', 'a glass city at dawn');
  wf = updateNodeParam(wf, findNode(wf, 'sampler')!.id, 'seed', 123);
  return wf;
}

describe('ComfyUI backend adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes configurable ComfyUI base URLs', () => {
    const adapter = new ComfyAdapter('http://127.0.0.1:8188///');
    expect(adapter.getBaseUrl()).toBe('http://127.0.0.1:8188');
    adapter.setBaseUrl('   ');
    expect(adapter.getBaseUrl()).toBe('http://127.0.0.1:8188');
  });

  it('health check succeeds using mocked fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ system: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new ComfyAdapter('http://comfy.local:8188');
    const health = await adapter.health();
    expect(health.ok).toBe(true);
    expect(health.status).toBe('healthy');
    expect(fetchMock).toHaveBeenCalledWith('http://comfy.local:8188/system_stats', expect.any(Object));
  });

  it('health check fails gracefully using mocked fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const adapter = new ComfyAdapter('http://127.0.0.1:8188');
    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe('unavailable');
    expect(health.message).toMatch(/Start ComfyUI/i);
  });
});

describe('streaming render previews', () => {
  it('builds an inline SVG preview for an in-flight job', () => {
    const job = buildRenderJob(wfWithModel());
    const preview = buildStreamingPreview(job, 0.42, 'rendering');
    expect(preview).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(preview)).toContain('rendering 42%');
  });
});

describe('backend settings and workflow mapping', () => {
  it('maps backend selection to TurboForge backend ids', () => {
    expect(settingsBackendToTurboBackend('mock')).toBe('mock');
    expect(settingsBackendToTurboBackend('comfyui')).toBe('comfyui-api');
    expect(settingsBackendToTurboBackend('bridge')).toBe('diffusers');
  });

  it('persists backend settings through localStorage serialization', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    const wf = wfWithModel();
    savePersisted({
      workflow: wf,
      rackPresets: [],
      gallery: [],
      backendSettings: sanitizeBackendSettings({
        selectedBackend: 'comfyui',
        comfyUrl: 'http://localhost:8188',
        fallbackToMock: false,
      }),
    });
    const restored = loadPersisted();
    expect(restored.backendSettings?.selectedBackend).toBe('comfyui');
    expect(restored.backendSettings?.comfyUrl).toBe('http://localhost:8188');
    vi.unstubAllGlobals();
  });

  it('substitutes prompt, seed, steps, resolution and checkpoint in a sample workflow', () => {
    const job = buildRenderJob(wfWithModel());
    const workflow = mapComfyTemplate(BASIC_TXT2IMG_TEMPLATE, job);
    expect((workflow['3'] as { inputs: Record<string, unknown> }).inputs.seed).toBe(123);
    expect((workflow['5'] as { inputs: Record<string, unknown> }).inputs.width).toBe(1024);
    expect((workflow['6'] as { inputs: Record<string, unknown> }).inputs.text).toBe('a glass city at dawn');
    expect((workflow['4'] as { inputs: Record<string, unknown> }).inputs.ckpt_name).toBe('ckpt-lumen-xl.safetensors');
  });
});

describe('store backend selection and manifests', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
  });

  it('updates backend selection and fallback settings in the store', () => {
    useStudio.getState().setAdapter('comfyui');
    useStudio.getState().updateBackendSettings({ comfyUrl: 'http://localhost:8188', fallbackToMock: false });
    const state = useStudio.getState();
    expect(state.adapterId).toBe('comfyui');
    expect(state.turboBackendId).toBe('comfyui-api');
    expect(state.backendSettings.fallbackToMock).toBe(false);
  });

  it('render planner and manifest include selected non-mock backend details', () => {
    const wf = wfWithModel();
    const plan = createRenderPlan(wf, DEMO_SHELF, { presetId: 'fast', backendId: 'comfyui-api' });
    expect(plan.selectedBackend).toBe('comfyui-api');
    const manifest = buildManifest(wf, DEMO_SHELF, '0.1.0', new Date('2026-07-02T12:00:00Z'));
    const enriched = withTurboForgeManifest(manifest, {
      preset: 'fast',
      backendId: 'comfyui-api',
      backendHealthStatus: 'healthy',
      optimizationFlags: plan.optimizationFlags,
      compileCacheStatus: plan.compileCacheStatus,
      modelCapability: buildCapabilityMatrix(DEMO_SHELF)[0],
      loraStack: plan.selectedLoras,
      renderPlan: plan,
      warnings: plan.warnings,
      hardwareInfo: { backendName: 'ComfyUI API backend' },
      appVersion: '0.1.0',
    });
    expect(enriched.turboForge.backendId).toBe('comfyui-api');
    expect(enriched.turboForge.renderPlan.selectedBackend).toBe('comfyui-api');
  });

  it('invalidates stale TurboForge plans when the preset changes', () => {
    useStudio.getState().resetWorkflow();
    useStudio.getState().setTurboPreset('fast');
    const fastPlan = useStudio.getState().createTurboPlan();

    useStudio.getState().setTurboPreset('draft');

    expect(useStudio.getState().turboLastPlan).toBeNull();
    const draftPlan = useStudio.getState().createTurboPlan();
    expect(draftPlan.id).not.toBe(fastPlan.id);
    expect(draftPlan.selectedPreset).toBe('draft');
  });

  it('benchmarks the real bridge adapter instead of the placeholder Diffusers slot', async () => {
    const generate = vi.spyOn(httpAdapter, 'generate').mockResolvedValue({
      dataUrl: 'data:image/png;base64,abc',
      mediaType: 'image',
      mimeType: 'image/png',
      extension: 'png',
      seed: 77,
      backendTimings: { totalRenderMs: 123, backendRequestMs: 123 },
    });
    useStudio.setState({
      adapterId: 'bridge',
      turboBackendId: 'diffusers',
      turboBenchmarks: [],
      turboLastBenchmark: null,
      turboLastPlan: null,
      turboBusy: false,
      turboError: null,
      backendSettings: sanitizeBackendSettings({
        selectedBackend: 'bridge',
        bridgeUrl: 'http://bridge.local',
        bridgeRenderer: 'diffusers',
        fallbackToMock: false,
      }),
    });

    await useStudio.getState().runTurboBenchmark();

    const state = useStudio.getState();
    expect(generate).toHaveBeenCalled();
    expect(state.turboError).toBeNull();
    expect(state.turboLastBenchmark?.backendId).toBe('diffusers');
    expect(state.turboLastBenchmark?.timings.totalRenderMs).toBe(123);
  });
});
