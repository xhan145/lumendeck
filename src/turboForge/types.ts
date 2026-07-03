import type { ModelFamily } from '../core/shelf';
import type { LoraSlot, Workflow } from '../core/types';

export type TurboTask =
  | 'text-to-image'
  | 'image-to-image'
  | 'image-to-video'
  | 'text-to-video'
  | 'video-to-video'
  | 'upscale'
  | 'interpolate'
  | 'encode';

export type PrecisionMode = 'fp32' | 'fp16' | 'bf16' | 'fp8-experimental';
export type OptimizationMode = 'safe' | 'fast' | 'turbo' | 'forge' | 'eco' | 'draft' | 'final';
export type TurboPresetId = 'safe' | 'fast' | 'turbo' | 'forge' | 'eco' | 'draft' | 'final';
export type BackendId = 'diffusers' | 'comfyui-api' | 'tensorrt' | 'onnx-runtime' | 'mock' | 'future-cloud';

export interface TurboOptimizationFlags {
  precision: PrecisionMode;
  optimizedAttention: boolean;
  xformers: boolean;
  scaledDotProductAttention: boolean;
  torchCompile: boolean;
  tensorRtEngine: boolean;
  onnxRuntime: boolean;
  vaeTiling: boolean;
  vaeSlicing: boolean;
  cpuOffload: boolean;
  gpuOffload: boolean;
  lowerStepCount: boolean;
  previewResolution: boolean;
  cachedTextEmbeddings: boolean;
  cachedImageConditioning: boolean;
  cachedVideoConditioning: boolean;
  cachedControlNetPreprocessing: boolean;
  loraFusion: boolean;
  loraCache: boolean;
  videoChunking: boolean;
  lowFpsPreview: boolean;
  frameInterpolation: boolean;
  encoderPreset: 'quality' | 'balanced' | 'fast' | 'preview';
}

export interface TurboPreset {
  id: TurboPresetId;
  label: string;
  beginnerLabel: string;
  description: string;
  flags: TurboOptimizationFlags;
  stepMultiplier: number;
  resolutionScale: number;
}

export interface HardwareInfo {
  cpuName?: string;
  gpuName?: string;
  ramGB?: number;
  vramGB?: number;
  backendName: string;
}

export interface RuntimeInfo {
  backendName: string;
  precisionMode: PrecisionMode;
  modelId: string | null;
  modelHash: string | null;
  loraStack: TurboLora[];
  resolution: { width: number; height: number };
  steps: number;
  frameCount?: number;
  fps?: number;
  seed: number;
  batchSize: number;
  dateTime: string;
}

export type PipelineTimingKey =
  | 'modelLoadMs'
  | 'loraLoadMs'
  | 'promptEncodingMs'
  | 'imagePreprocessingMs'
  | 'videoPreprocessingMs'
  | 'conditioningPreprocessingMs'
  | 'samplingMs'
  | 'vaeDecodeMs'
  | 'upscalingMs'
  | 'frameInterpolationMs'
  | 'videoEncodingMs'
  | 'saveExportMs'
  | 'totalRenderMs';

export type PipelineTimings = Partial<Record<PipelineTimingKey, number>>;

export interface BenchmarkResult {
  id: string;
  createdAt: string;
  presetId: TurboPresetId;
  backendId: BackendId;
  backendName: string;
  hardware: HardwareInfo;
  runtime: RuntimeInfo;
  timings: PipelineTimings;
  baselineMs?: number;
  optimizedMs?: number;
  measuredSpeedupPercent?: number;
  video?: VideoBenchmarkMetrics;
}

export interface TurboLora extends LoraSlot {
  name: string;
  path: string;
  hash: string;
  family: ModelFamily;
  compatible: boolean;
  warning?: string;
}

export interface LoraStackPreset {
  id: string;
  name: string;
  loras: TurboLora[];
}

export interface ModelCapability {
  id: string;
  displayName: string;
  family: ModelFamily | 'LTX' | 'HunyuanVideo' | 'Unknown';
  taskTypes: TurboTask[];
  localPath: string;
  fileHash: string;
  licenseNotes: string;
  vramEstimateGB: number;
  supportedResolutions: string[];
  supportedPrecisionModes: PrecisionMode[];
  loraSupport: boolean;
  conditioningSupport: boolean;
  compileSupport: boolean;
  tensorRtSupport: boolean;
  onnxSupport: boolean;
  videoSupport: boolean;
  knownIncompatibilities: string[];
  recommendedPreset: TurboPresetId;
}

export interface CompileCacheKeyParts {
  modelHash: string;
  backendId: BackendId;
  hardwareId: string;
  precision: PrecisionMode;
  resolutionBucket: string;
  batchSize: number;
  appVersion?: string;
  optimizationMode: OptimizationMode;
  graphVersion?: number;
}

export interface CompileCacheEntry extends CompileCacheKeyParts {
  key: string;
  createdAt: string;
  lastUsedAt: string;
  sizeBytes?: number;
  stale: boolean;
  status: 'hit' | 'miss' | 'stale' | 'failed';
  error?: string;
}

export interface RenderPlanWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  recommendedFix?: string;
}

export interface RenderPlan {
  id: string;
  createdAt: string;
  selectedBackend: BackendId;
  selectedTask: TurboTask;
  selectedModel: string | null;
  selectedModelFamily: ModelCapability['family'] | null;
  selectedLoras: TurboLora[];
  selectedPreset: TurboPresetId;
  estimatedVramGB: number;
  estimatedRenderTimeMs?: number;
  resolution: { width: number; height: number };
  steps: number;
  seed: number;
  batchSize: number;
  frameCount?: number;
  fps?: number;
  requiredPreprocessing: string[];
  cacheStatus: 'hit' | 'miss' | 'stale' | 'unknown';
  compileCacheStatus: 'hit' | 'miss' | 'stale' | 'unknown';
  outputFormat: string;
  warnings: RenderPlanWarning[];
  recommendedFixes: string[];
  optimizationFlags: TurboOptimizationFlags;
  cacheKey: string;
}

export interface VideoOptimizationSettings {
  draftFpsMode: boolean;
  lowFramePreview: boolean;
  keyframeOnlyPreview: boolean;
  chunkedRendering: boolean;
  resumeFromFailedChunk: boolean;
  cachedConditioningFrames: boolean;
  cachedPromptEmbeddingsPerSegment: boolean;
  frameInterpolation: boolean;
  videoUpscale: boolean;
  encoderPreset: 'quality' | 'balanced' | 'fast' | 'preview';
  chunkSizeFrames: number;
}

export interface VideoBenchmarkMetrics {
  secondsPerFrame: number;
  totalRenderTimeMs: number;
  encodeTimeMs: number;
  peakMemoryGB?: number;
  chunkCount: number;
  failedChunkCount: number;
  resumedChunkCount: number;
  fps: number;
  durationSeconds: number;
  resolution: { width: number; height: number };
}

export interface TurboForgeManifestData {
  preset: TurboPresetId;
  backendId: BackendId;
  backendHealthStatus: 'healthy' | 'unavailable' | 'degraded';
  optimizationFlags: TurboOptimizationFlags;
  compileCacheStatus: RenderPlan['compileCacheStatus'];
  modelCapability: ModelCapability | null;
  loraStack: TurboLora[];
  renderPlan: RenderPlan;
  benchmark?: BenchmarkResult;
  warnings: RenderPlanWarning[];
  hardwareInfo: HardwareInfo;
  graphSnapshot?: Workflow;
  appVersion?: string;
}
