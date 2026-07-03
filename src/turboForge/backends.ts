import type {
  BackendId,
  BenchmarkResult,
  ModelCapability,
  PrecisionMode,
  RenderPlan,
  TurboTask,
} from './types';
import { DEFAULT_COMFY_URL } from '../bridge/comfyAdapter';

export interface BackendHealth {
  status: 'healthy' | 'unavailable' | 'degraded';
  message: string;
}

export interface TurboRenderResult {
  outputRef: string;
  seed: number;
  manifestPatch: Record<string, unknown>;
}

export interface TurboBackendAdapter {
  id: BackendId;
  displayName: string;
  supportedTasks: TurboTask[];
  supportedModelFamilies: ModelCapability['family'][];
  supportedPrecisionModes: PrecisionMode[];
  supportedOptimizationModes: string[];
  healthCheck(): Promise<BackendHealth>;
  loadModel(model: ModelCapability): Promise<void>;
  unloadModel(modelId: string): Promise<void>;
  warmup(plan: RenderPlan): Promise<void>;
  render(plan: RenderPlan): Promise<TurboRenderResult>;
  cancel(jobId: string): Promise<void>;
  benchmark(plan: RenderPlan): Promise<BenchmarkResult>;
  exportManifest(): Record<string, unknown>;
}

const allTasks: TurboTask[] = [
  'text-to-image',
  'image-to-image',
  'image-to-video',
  'text-to-video',
  'video-to-video',
  'upscale',
  'interpolate',
  'encode',
];

abstract class PlaceholderBackend implements TurboBackendAdapter {
  supportedTasks = allTasks;
  supportedModelFamilies: ModelCapability['family'][] = ['SD1.5', 'SDXL', 'SD3', 'Flux', 'LTX', 'HunyuanVideo'];
  supportedPrecisionModes: PrecisionMode[] = ['fp32', 'fp16', 'bf16'];
  supportedOptimizationModes = ['safe', 'fast', 'turbo', 'forge', 'eco', 'draft', 'final'];

  constructor(public id: BackendId, public displayName: string) {}

  async healthCheck(): Promise<BackendHealth> {
    return { status: 'unavailable', message: `${this.displayName} adapter slot is ready, but no runtime is connected.` };
  }

  async loadModel(): Promise<void> {
    throw new Error(`${this.displayName} is not connected.`);
  }

  async unloadModel(): Promise<void> {}

  async warmup(): Promise<void> {
    throw new Error(`${this.displayName} is not connected.`);
  }

  async render(): Promise<TurboRenderResult> {
    throw new Error(`${this.displayName} is not connected.`);
  }

  async cancel(): Promise<void> {}

  async benchmark(_plan: RenderPlan): Promise<BenchmarkResult> {
    throw new Error(`${this.displayName} is not connected.`);
  }

  exportManifest(): Record<string, unknown> {
    return { id: this.id, displayName: this.displayName, status: 'slot-only' };
  }
}

class ComfyTurboBackend extends PlaceholderBackend {
  constructor() {
    super('comfyui-api', 'ComfyUI API backend');
  }

  async healthCheck(): Promise<BackendHealth> {
    const started = performance.now();
    try {
      const res = await fetch(`${DEFAULT_COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(3000) });
      const elapsed = Math.round(performance.now() - started);
      if (!res.ok) return { status: 'degraded', message: `ComfyUI responded with HTTP ${res.status} after ${elapsed} ms.` };
      return { status: 'healthy', message: `ComfyUI is reachable at ${DEFAULT_COMFY_URL} (${elapsed} ms).` };
    } catch {
      return {
        status: 'unavailable',
        message: `ComfyUI is not reachable at ${DEFAULT_COMFY_URL}. Use Backend Settings if your server runs elsewhere.`,
      };
    }
  }

  async benchmark(plan: RenderPlan): Promise<BenchmarkResult> {
    const started = performance.now();
    const health = await this.healthCheck();
    const healthMs = performance.now() - started;
    if (health.status !== 'healthy') {
      throw new Error(health.message);
    }
    return {
      id: `bench_${plan.id}`,
      createdAt: new Date().toISOString(),
      presetId: plan.selectedPreset,
      backendId: this.id,
      backendName: this.displayName,
      hardware: { backendName: this.displayName },
      runtime: {
        backendName: this.displayName,
        precisionMode: plan.optimizationFlags.precision,
        modelId: plan.selectedModel,
        modelHash: null,
        loraStack: plan.selectedLoras,
        resolution: plan.resolution,
        steps: plan.steps,
        frameCount: plan.frameCount,
        fps: plan.fps,
        seed: plan.seed,
        batchSize: plan.batchSize,
        dateTime: new Date().toISOString(),
      },
      timings: {
        healthCheckMs: healthMs,
        totalRenderMs: healthMs,
      },
      optimizedMs: healthMs,
    };
  }

  exportManifest(): Record<string, unknown> {
    return { id: this.id, displayName: this.displayName, defaultUrl: DEFAULT_COMFY_URL };
  }
}

export class MockTurboBackend implements TurboBackendAdapter {
  id: BackendId = 'mock';
  displayName = 'Mock backend';
  supportedTasks = allTasks;
  supportedModelFamilies: ModelCapability['family'][] = ['SD1.5', 'SDXL', 'SD3', 'Flux', 'LTX', 'HunyuanVideo'];
  supportedPrecisionModes: PrecisionMode[] = ['fp32', 'fp16', 'bf16'];
  supportedOptimizationModes = ['safe', 'fast', 'turbo', 'forge', 'eco', 'draft', 'final'];

  async healthCheck(): Promise<BackendHealth> {
    return { status: 'healthy', message: 'Mock backend is available without a GPU.' };
  }

  async loadModel(): Promise<void> {}
  async unloadModel(): Promise<void> {}
  async warmup(): Promise<void> {}
  async cancel(): Promise<void> {}

  async render(plan: RenderPlan): Promise<TurboRenderResult> {
    return {
      outputRef: `mock://${plan.id}`,
      seed: plan.seed,
      manifestPatch: { turboForgePlanId: plan.id },
    };
  }

  async benchmark(plan: RenderPlan): Promise<BenchmarkResult> {
    const total = Math.max(50, plan.steps * 12 + plan.resolution.width * plan.resolution.height * 0.00008);
    return {
      id: `bench_${plan.id}`,
      createdAt: new Date().toISOString(),
      presetId: plan.selectedPreset,
      backendId: this.id,
      backendName: this.displayName,
      hardware: { backendName: this.displayName, gpuName: 'No GPU required' },
      runtime: {
        backendName: this.displayName,
        precisionMode: plan.optimizationFlags.precision,
        modelId: plan.selectedModel,
        modelHash: null,
        loraStack: plan.selectedLoras,
        resolution: plan.resolution,
        steps: plan.steps,
        frameCount: plan.frameCount,
        fps: plan.fps,
        seed: plan.seed,
        batchSize: plan.batchSize,
        dateTime: new Date().toISOString(),
      },
      timings: {
        modelLoadMs: 8,
        loraLoadMs: plan.selectedLoras.length * 3,
        promptEncodingMs: 5,
        imagePreprocessingMs: 2,
        conditioningPreprocessingMs: plan.requiredPreprocessing.length * 2,
        samplingMs: total * 0.7,
        vaeDecodeMs: total * 0.14,
        saveExportMs: total * 0.08,
        totalRenderMs: total,
      },
      optimizedMs: total,
    };
  }

  exportManifest(): Record<string, unknown> {
    return { id: this.id, displayName: this.displayName, status: 'healthy' };
  }
}

export const TURBO_BACKENDS: Record<BackendId, TurboBackendAdapter> = {
  diffusers: new (class extends PlaceholderBackend {
    constructor() {
      super('diffusers', 'Diffusers backend');
    }
  })(),
  'comfyui-api': new ComfyTurboBackend(),
  tensorrt: new (class extends PlaceholderBackend {
    constructor() {
      super('tensorrt', 'TensorRT backend');
    }
  })(),
  'onnx-runtime': new (class extends PlaceholderBackend {
    constructor() {
      super('onnx-runtime', 'ONNX Runtime backend');
    }
  })(),
  mock: new MockTurboBackend(),
  'future-cloud': new (class extends PlaceholderBackend {
    constructor() {
      super('future-cloud', 'Future Cloud backend');
    }
  })(),
};
