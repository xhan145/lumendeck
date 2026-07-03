import { buildRenderJob } from '../bridge/adapter';
import { findAsset, type ModelAsset } from '../core/shelf';
import type { LoraSlot, Workflow } from '../core/types';
import { findNode } from '../core/workflow';
import { APP_VERSION } from '../state/storeConstants';
import { turboCompileCache, resolutionBucket } from './cache';
import { activeTurboLoras, loraOverheadMs, loraWarnings } from './loraOptimizer';
import { buildCapabilityMatrix, findCapability } from './modelMatrix';
import { applyPresetSteps, getTurboPreset } from './presets';
import type { BackendId, BenchmarkResult, RenderPlan, RenderPlanWarning, TurboPresetId, TurboTask } from './types';

function planId(): string {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface RenderPlanOptions {
  presetId: TurboPresetId;
  backendId: BackendId;
  task?: TurboTask;
  history?: BenchmarkResult[];
}

export function createRenderPlan(wf: Workflow, shelf: ModelAsset[], options: RenderPlanOptions): RenderPlan {
  const job = buildRenderJob(wf);
  const preset = getTurboPreset(options.presetId);
  const matrix = buildCapabilityMatrix(shelf);
  const capability = findCapability(matrix, job.modelId);
  const canvas = findNode(wf, 'canvas');
  const rack = findNode(wf, 'loraRack');
  const exportNode = findNode(wf, 'export');
  const control = findNode(wf, 'control');
  const slots = ((rack?.params.slots as LoraSlot[] | undefined) ?? []);
  const loras = activeTurboLoras(slots, shelf, capability);
  const batchSize = Number(canvas?.params.batch ?? 1);
  const width = Math.max(64, Math.round(job.width * preset.resolutionScale / 8) * 8);
  const height = Math.max(64, Math.round(job.height * preset.resolutionScale / 8) * 8);
  const steps = applyPresetSteps(job.steps, preset.id);
  const task = options.task ?? 'text-to-image';
  const warnings: RenderPlanWarning[] = [];

  if (!capability) {
    warnings.push({ code: 'missing-model', severity: 'error', message: 'Choose an installed model before rendering.', recommendedFix: 'Open Model Shelf and select a checkpoint.' });
  } else {
    const asset = findAsset(shelf, capability.id);
    if (!asset?.installed) warnings.push({ code: 'model-not-installed', severity: 'error', message: `${capability.displayName} is not installed locally.`, recommendedFix: 'Install the model or switch to an installed checkpoint.' });
    if (!capability.taskTypes.includes(task)) warnings.push({ code: 'task-unsupported', severity: 'warning', message: `${capability.displayName} does not advertise ${task} support.`, recommendedFix: 'Switch model or task before running a long render.' });
    if (preset.id === 'forge' && !capability.compileSupport) warnings.push({ code: 'compile-unsupported', severity: 'warning', message: 'Forge compile is not supported by this model yet.', recommendedFix: 'Use Fast or Turbo, or choose a model with compile support.' });
    if (preset.flags.tensorRtEngine && !capability.tensorRtSupport) warnings.push({ code: 'tensorrt-unsupported', severity: 'info', message: 'TensorRT is not available for this model; TurboForge will fall back safely.', recommendedFix: 'Use Forge only after installing a TensorRT-capable backend.' });
  }

  for (const warning of loraWarnings(loras, capability)) {
    warnings.push({ code: 'lora-warning', severity: 'warning', message: warning, recommendedFix: 'Disable incompatible LoRAs or save a compatible LoRA stack preset.' });
  }

  const megapixels = (width * height) / 1_000_000;
  const estimatedVramGB = Number(((capability?.vramEstimateGB ?? 4) * megapixels * batchSize / 1.05).toFixed(1));
  if (estimatedVramGB > 12) warnings.push({ code: 'vram-heavy', severity: 'warning', message: `This plan may need about ${estimatedVramGB} GB VRAM.`, recommendedFix: 'Reduce resolution, use Eco, enable tiled decode, or lower batch size.' });
  if (steps > 60) warnings.push({ code: 'high-steps', severity: 'info', message: 'High step counts slow iteration.', recommendedFix: 'Use Draft first, then Final for export.' });

  const requiredPreprocessing = [
    'prompt embeddings',
    ...(control?.params.enabled ? ['conditioning preprocessing'] : []),
    ...(task.includes('video') ? ['video conditioning frames', 'video chunks'] : []),
  ];
  const cacheEntry = turboCompileCache.get({
    modelHash: capability?.fileHash ?? 'no-model',
    backendId: options.backendId,
    hardwareId: 'browser',
    precision: preset.flags.precision,
    resolutionBucket: resolutionBucket(width, height),
    batchSize,
    appVersion: APP_VERSION,
    optimizationMode: preset.id,
    graphVersion: wf.version,
  });
  const similar = options.history?.find((bench) => bench.runtime.modelId === job.modelId && bench.presetId === preset.id);
  const estimatedRenderTimeMs = similar?.timings.totalRenderMs
    ? similar.timings.totalRenderMs + loraOverheadMs(loras)
    : undefined;

  return {
    id: planId(),
    createdAt: new Date().toISOString(),
    selectedBackend: options.backendId,
    selectedTask: task,
    selectedModel: job.modelId,
    selectedModelFamily: capability?.family ?? null,
    selectedLoras: loras,
    selectedPreset: preset.id,
    estimatedVramGB,
    estimatedRenderTimeMs,
    resolution: { width, height },
    steps,
    seed: job.seed,
    batchSize,
    frameCount: task.includes('video') ? 48 : undefined,
    fps: task.includes('video') ? (preset.flags.lowFpsPreview ? 8 : 24) : undefined,
    requiredPreprocessing,
    cacheStatus: requiredPreprocessing.length > 0 ? 'miss' : 'unknown',
    compileCacheStatus: cacheEntry.status === 'failed' ? 'miss' : cacheEntry.status,
    outputFormat: String(exportNode?.params.format ?? 'png'),
    warnings,
    recommendedFixes: [...new Set(warnings.flatMap((warning) => warning.recommendedFix ? [warning.recommendedFix] : []))],
    optimizationFlags: preset.flags,
    cacheKey: cacheEntry.key,
  };
}
