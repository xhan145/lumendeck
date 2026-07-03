import { describe, expect, it } from 'vitest';
import { MockTurboBackend, TURBO_BACKENDS, type TurboBackendAdapter } from '../src/turboForge/backends';
import { clearBenchmarks, loadBenchmarks, measuredSpeedupPercent, saveBenchmark, type BenchmarkStorage } from '../src/turboForge/benchmarks';
import { CompileCache, createCompileCacheKey, resolutionBucket } from '../src/turboForge/cache';
import { activeTurboLoras, loraOverheadMs, rackPresetToTurboPreset, saveLoraStackPreset } from '../src/turboForge/loraOptimizer';
import { withTurboForgeManifest } from '../src/turboForge/manifest';
import { buildCapabilityMatrix, validateModelCapability } from '../src/turboForge/modelMatrix';
import { applyPresetSteps, TURBO_PRESETS } from '../src/turboForge/presets';
import { createRenderPlan } from '../src/turboForge/renderPlanner';
import { createVideoBenchmarkMetrics } from '../src/turboForge/video';
import { buildManifest } from '../src/core/manifest';
import type { LoraSlot } from '../src/core/types';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';

class MemoryStorage implements BenchmarkStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function workflowWithModel() {
  let wf = createDefaultWorkflow();
  wf = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-lumen-xl');
  return wf;
}

describe('TurboForge backend adapter interface', () => {
  it('exposes every required backend slot', () => {
    expect(Object.keys(TURBO_BACKENDS).sort()).toEqual([
      'comfyui-api',
      'diffusers',
      'future-cloud',
      'mock',
      'onnx-runtime',
      'tensorrt',
    ]);
  });

  it('mock backend renders and benchmarks without a GPU', async () => {
    const adapter: TurboBackendAdapter = new MockTurboBackend();
    const plan = createRenderPlan(workflowWithModel(), DEMO_SHELF, { presetId: 'fast', backendId: 'mock' });
    await expect(adapter.healthCheck()).resolves.toMatchObject({ status: 'healthy' });
    await expect(adapter.render(plan)).resolves.toMatchObject({ seed: plan.seed });
    const benchmark = await adapter.benchmark(plan);
    expect(benchmark.timings.totalRenderMs).toBeGreaterThan(0);
  });
});

describe('TurboForge benchmarks', () => {
  it('saves, loads, clears, and computes measured speedup only from real timings', () => {
    const storage = new MemoryStorage();
    const plan = createRenderPlan(workflowWithModel(), DEMO_SHELF, { presetId: 'safe', backendId: 'mock' });
    const benchmark = {
      id: 'bench-1',
      createdAt: '2026-07-02T12:00:00.000Z',
      presetId: 'safe' as const,
      backendId: 'mock' as const,
      backendName: 'Mock backend',
      hardware: { backendName: 'Mock backend' },
      runtime: {
        backendName: 'Mock backend',
        precisionMode: 'fp16' as const,
        modelId: plan.selectedModel,
        modelHash: 'a1',
        loraStack: [],
        resolution: plan.resolution,
        steps: plan.steps,
        seed: plan.seed,
        batchSize: plan.batchSize,
        dateTime: '2026-07-02T12:00:00.000Z',
      },
      timings: { totalRenderMs: 1000 },
    };
    saveBenchmark(benchmark, storage);
    expect(loadBenchmarks(storage)).toHaveLength(1);
    expect(measuredSpeedupPercent(1000, 750)).toBe(25);
    expect(measuredSpeedupPercent(undefined, 750)).toBeUndefined();
    clearBenchmarks(storage);
    expect(loadBenchmarks(storage)).toHaveLength(0);
  });
});

describe('Turbo presets and compile cache', () => {
  it('maps all user-facing presets to optimization flags', () => {
    expect(Object.keys(TURBO_PRESETS).sort()).toEqual(['draft', 'eco', 'fast', 'final', 'forge', 'safe', 'turbo']);
    expect(TURBO_PRESETS.forge.flags.torchCompile).toBe(true);
    expect(TURBO_PRESETS.draft.flags.previewResolution).toBe(true);
    expect(applyPresetSteps(40, 'draft')).toBeLessThan(40);
  });

  it('creates cache keys with required parts and detects stale entries', () => {
    const parts = {
      modelHash: 'hash',
      backendId: 'mock' as const,
      hardwareId: 'gpu',
      precision: 'fp16' as const,
      resolutionBucket: resolutionBucket(1025, 769),
      batchSize: 2,
      appVersion: '0.1.0',
      optimizationMode: 'forge' as const,
      graphVersion: 7,
    };
    expect(createCompileCacheKey(parts)).toContain('hash');
    expect(parts.resolutionBucket).toBe('1152x896');
    const cache = new CompileCache();
    const miss = cache.get(parts);
    expect(miss.status).toBe('miss');
    const entry = cache.put(parts, 12);
    expect(cache.get(parts).status).toBe('hit');
    cache.markStale(entry.key);
    expect(cache.get(parts).status).toBe('stale');
    expect(cache.estimateSizeBytes()).toBe(12);
    cache.delete(entry.key);
    expect(cache.list()).toHaveLength(0);
  });
});

describe('model matrix and LoRA optimizer', () => {
  it('validates model capability matrix entries', () => {
    const matrix = buildCapabilityMatrix(DEMO_SHELF);
    expect(matrix.length).toBeGreaterThan(0);
    expect(validateModelCapability(matrix[0])).toEqual([]);
  });

  it('loads active LoRAs, saves stack presets, and reports overhead', () => {
    const matrix = buildCapabilityMatrix(DEMO_SHELF);
    const model = matrix.find((m) => m.id === 'ckpt-lumen-xl')!;
    const slots: LoraSlot[] = [
      { assetId: 'lora-neon-bloom', enabled: true, weight: 0.7 },
      { assetId: 'lora-retro-grain', enabled: true, weight: 0.8 },
      { assetId: 'lora-inkwash', enabled: false, weight: 0.4 },
    ];
    const active = activeTurboLoras(slots, DEMO_SHELF, model);
    expect(active).toHaveLength(2);
    expect(active.some((lora) => !lora.compatible)).toBe(true);
    expect(loraOverheadMs(active)).toBeGreaterThan(0);
    expect(saveLoraStackPreset('stack-1', 'Stack', active).loras).toHaveLength(2);
    expect(rackPresetToTurboPreset({ id: 'rack-1', name: 'Rack', slots }, DEMO_SHELF, model).loras).toHaveLength(2);
  });
});

describe('render planning, video fields, and manifest export', () => {
  it('warns and recommends fixes for heavy or incompatible plans', () => {
    let wf = workflowWithModel();
    wf = updateNodeParam(wf, findNode(wf, 'canvas')!.id, 'width', 2048);
    wf = updateNodeParam(wf, findNode(wf, 'canvas')!.id, 'height', 2048);
    wf = updateNodeParam(wf, findNode(wf, 'loraRack')!.id, 'slots', [
      { assetId: 'lora-retro-grain', enabled: true, weight: 0.8 },
    ] satisfies LoraSlot[]);
    const plan = createRenderPlan(wf, DEMO_SHELF, { presetId: 'final', backendId: 'mock' });
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.recommendedFixes.join(' ')).toMatch(/Eco|Disable/i);
  });

  it('includes MotionDeck video optimization fields and metrics', () => {
    const plan = createRenderPlan(workflowWithModel(), DEMO_SHELF, {
      presetId: 'draft',
      backendId: 'mock',
      task: 'text-to-video',
    });
    expect(plan.frameCount).toBe(48);
    expect(plan.fps).toBe(8);
    const metrics = createVideoBenchmarkMetrics({
      totalRenderTimeMs: 4800,
      encodeTimeMs: 300,
      frameCount: 48,
      fps: 8,
      width: 512,
      height: 512,
      chunkCount: 2,
      resumedChunkCount: 1,
    });
    expect(metrics.secondsPerFrame).toBeCloseTo(0.1);
    expect(metrics.durationSeconds).toBe(6);
  });

  it('exports TurboForge data into manifests', () => {
    const wf = workflowWithModel();
    const plan = createRenderPlan(wf, DEMO_SHELF, { presetId: 'fast', backendId: 'mock' });
    const manifest = buildManifest(wf, DEMO_SHELF, '0.1.0', new Date('2026-07-02T12:00:00Z'));
    const modelCapability = buildCapabilityMatrix(DEMO_SHELF)[0];
    const enriched = withTurboForgeManifest(manifest, {
      preset: 'fast',
      backendId: 'mock',
      backendHealthStatus: 'healthy',
      optimizationFlags: plan.optimizationFlags,
      compileCacheStatus: plan.compileCacheStatus,
      modelCapability,
      loraStack: plan.selectedLoras,
      renderPlan: plan,
      warnings: plan.warnings,
      hardwareInfo: { backendName: 'Mock backend' },
      graphSnapshot: wf,
      appVersion: '0.1.0',
    });
    expect(enriched.turboForge.preset).toBe('fast');
    expect(enriched.turboForge.renderPlan.id).toBe(plan.id);
  });
});
