import type { TurboOptimizationFlags, TurboPreset, TurboPresetId } from './types';

const baseFlags: TurboOptimizationFlags = {
  precision: 'fp16',
  optimizedAttention: true,
  xformers: false,
  scaledDotProductAttention: true,
  torchCompile: false,
  tensorRtEngine: false,
  onnxRuntime: false,
  vaeTiling: false,
  vaeSlicing: false,
  cpuOffload: false,
  gpuOffload: false,
  lowerStepCount: false,
  previewResolution: false,
  cachedTextEmbeddings: true,
  cachedImageConditioning: true,
  cachedVideoConditioning: true,
  cachedControlNetPreprocessing: true,
  loraFusion: false,
  loraCache: true,
  videoChunking: true,
  lowFpsPreview: false,
  frameInterpolation: false,
  encoderPreset: 'balanced',
};

function flags(patch: Partial<TurboOptimizationFlags>): TurboOptimizationFlags {
  return { ...baseFlags, ...patch };
}

export const TURBO_PRESETS: Record<TurboPresetId, TurboPreset> = {
  safe: {
    id: 'safe',
    label: 'Safe',
    beginnerLabel: 'Safe: most reliable',
    description: 'Most reliable settings with conservative precision and memory behavior.',
    flags: flags({ precision: 'fp32', optimizedAttention: false, scaledDotProductAttention: false }),
    stepMultiplier: 1,
    resolutionScale: 1,
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    beginnerLabel: 'Fast: good default',
    description: 'Good default: cached setup work and modern attention when available.',
    flags: flags({}),
    stepMultiplier: 0.85,
    resolutionScale: 1,
  },
  turbo: {
    id: 'turbo',
    label: 'Turbo',
    beginnerLabel: 'Turbo: faster if supported',
    description: 'More aggressive acceleration when the selected backend and hardware support it.',
    flags: flags({ torchCompile: true, loraFusion: true, xformers: true, lowerStepCount: true }),
    stepMultiplier: 0.7,
    resolutionScale: 1,
  },
  forge: {
    id: 'forge',
    label: 'Forge',
    beginnerLabel: 'Forge: compile for max speed',
    description: 'One-time compile or engine build with safe fallback if compilation fails.',
    flags: flags({ torchCompile: true, tensorRtEngine: true, loraFusion: true }),
    stepMultiplier: 0.85,
    resolutionScale: 1,
  },
  eco: {
    id: 'eco',
    label: 'Eco',
    beginnerLabel: 'Eco: lower memory',
    description: 'Lower memory mode using offload and tiled decode.',
    flags: flags({ vaeTiling: true, vaeSlicing: true, cpuOffload: true, precision: 'fp16' }),
    stepMultiplier: 0.9,
    resolutionScale: 0.85,
  },
  draft: {
    id: 'draft',
    label: 'Draft',
    beginnerLabel: 'Draft: fast preview',
    description: 'Fast previews with fewer steps, smaller resolution, and video preview shortcuts.',
    flags: flags({
      lowerStepCount: true,
      previewResolution: true,
      lowFpsPreview: true,
      encoderPreset: 'preview',
    }),
    stepMultiplier: 0.45,
    resolutionScale: 0.6,
  },
  final: {
    id: 'final',
    label: 'Final',
    beginnerLabel: 'Final: high-quality export',
    description: 'High-quality export settings that keep optimizations honest and measured.',
    flags: flags({ encoderPreset: 'quality', frameInterpolation: true }),
    stepMultiplier: 1.15,
    resolutionScale: 1,
  },
};

export function getTurboPreset(id: TurboPresetId): TurboPreset {
  return TURBO_PRESETS[id];
}

export function applyPresetSteps(baseSteps: number, id: TurboPresetId): number {
  return Math.max(1, Math.round(baseSteps * getTurboPreset(id).stepMultiplier));
}
