/**
 * Hardware profile registry.
 *
 * A profile is a bundle of conservative-vs-permissive generation defaults,
 * precision preferences, and memory optimizations. Profiles are pure data:
 * detection (detection.ts), budgeting (memoryBudget.ts), and the render job
 * transform (applyProfile.ts) all read from here so there is a single source of
 * truth instead of scattered GPU-name checks.
 *
 * `auto` is a *selectable* id that resolves to one of the concrete effective
 * profiles via hardware detection; it has no registry entry of its own.
 */

/** What the user can pick in Settings. */
export type HardwareProfileId = 'auto' | 'gtx_1650_4gb' | 'balanced' | 'high_performance' | 'cpu';

/** A concrete profile the runtime actually applies (what `auto` resolves to). */
export type EffectiveProfileId = Exclude<HardwareProfileId, 'auto'>;

/** Precision the backend should prefer. bf16 is intentionally rare — only when confirmed. */
export type PrecisionPref = 'fp16' | 'bf16' | 'mixed' | 'fp32';

export interface HardwareProfileDefaults {
  batchSize: number;
  concurrentGenerations: number;
  parallelModelLoading: boolean;
  /** Preferred square resolution side, px. */
  defaultResolution: number;
  /** Conservative maximum square side, px (only exceeded when verified to fit). */
  maxResolution: number;
  /** Whether the high-res fix pass is allowed to run by default. */
  hiresFix: boolean;
  /** How large upscale operations are handled. */
  largeUpscale: 'enabled' | 'warn' | 'disabled';
  /** Live-preview policy (previews can cost VRAM). */
  livePreviews: 'full' | 'reduced' | 'off';
  autoUnloadInactive: boolean;
  /** How many models may stay cached (1 = only the active one). */
  modelCacheSize: number;
  preloadCheckpoints: boolean;
  keepSingleModelOnGpu: boolean;
  moveIdleModelsOffGpu: boolean;
}

export interface HardwareMemoryOptimizations {
  attentionSlicing: boolean;
  vaeSlicing: boolean;
  vaeTiling: boolean;
  modelCpuOffload: boolean;
  sequentialCpuOffload: boolean;
  tiledDecode: boolean;
  memoryEfficientAttention: boolean;
  unloadTextEncoders: boolean;
  /** Drop Python references before asking CUDA to release cache. */
  clearRefsBeforeCacheCleanup: boolean;
}

export interface HardwareProfile {
  id: EffectiveProfileId;
  /** User-facing name. */
  name: string;
  description: string;
  defaults: HardwareProfileDefaults;
  /** Precision candidates, most-preferred first; the first hardware-supported one wins. */
  precisionOrder: PrecisionPref[];
  memoryOptimizations: HardwareMemoryOptimizations;
  /** Hard VRAM budget in MB, or null when the profile imposes no explicit budget. */
  vramBudgetMb: number | null;
  /** Compact status label shown when the profile is active. */
  statusLabel: string;
}

/** Order matters: this is the order shown in the Settings selector. */
export const HARDWARE_PROFILE_IDS: HardwareProfileId[] = [
  'auto',
  'gtx_1650_4gb',
  'balanced',
  'high_performance',
  'cpu',
];

const noOptimizations: HardwareMemoryOptimizations = {
  attentionSlicing: false,
  vaeSlicing: false,
  vaeTiling: false,
  modelCpuOffload: false,
  sequentialCpuOffload: false,
  tiledDecode: false,
  memoryEfficientAttention: false,
  unloadTextEncoders: false,
  clearRefsBeforeCacheCleanup: true,
};

export const HARDWARE_PROFILES: Record<EffectiveProfileId, HardwareProfile> = {
  gtx_1650_4gb: {
    id: 'gtx_1650_4gb',
    name: 'GTX 1650 4GB',
    description:
      'Low-VRAM settings optimized for NVIDIA GTX 1650-class GPUs. Prioritizes stable local generation and avoids GPU memory crashes.',
    defaults: {
      batchSize: 1,
      concurrentGenerations: 1,
      parallelModelLoading: false,
      defaultResolution: 512,
      maxResolution: 768,
      hiresFix: false,
      largeUpscale: 'warn',
      livePreviews: 'reduced',
      autoUnloadInactive: true,
      modelCacheSize: 1,
      preloadCheckpoints: false,
      keepSingleModelOnGpu: true,
      moveIdleModelsOffGpu: true,
    },
    // FP16 first (fits 4GB, stable on Turing), then mixed, then FP32. No bf16.
    precisionOrder: ['fp16', 'mixed', 'fp32'],
    memoryOptimizations: {
      attentionSlicing: true,
      vaeSlicing: true,
      vaeTiling: true,
      modelCpuOffload: true,
      sequentialCpuOffload: false,
      tiledDecode: true,
      memoryEfficientAttention: true,
      unloadTextEncoders: true,
      clearRefsBeforeCacheCleanup: true,
    },
    vramBudgetMb: 4096,
    statusLabel: '4GB VRAM mode active',
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    description: 'Default behavior for mid-range GPUs (roughly 6–8 GB). Light memory savings, no forced offload.',
    defaults: {
      batchSize: 1,
      concurrentGenerations: 1,
      parallelModelLoading: false,
      defaultResolution: 768,
      maxResolution: 1024,
      hiresFix: true,
      largeUpscale: 'enabled',
      livePreviews: 'full',
      autoUnloadInactive: true,
      modelCacheSize: 2,
      preloadCheckpoints: false,
      keepSingleModelOnGpu: true,
      moveIdleModelsOffGpu: false,
    },
    precisionOrder: ['fp16', 'fp32'],
    memoryOptimizations: {
      ...noOptimizations,
      attentionSlicing: true,
      vaeSlicing: true,
      vaeTiling: true,
    },
    vramBudgetMb: 8192,
    statusLabel: 'Balanced GPU mode',
  },
  high_performance: {
    id: 'high_performance',
    name: 'High Performance',
    description: 'For large-VRAM GPUs (roughly 12 GB+). Prioritizes speed and image size over memory savings.',
    defaults: {
      batchSize: 1,
      concurrentGenerations: 1,
      parallelModelLoading: true,
      defaultResolution: 1024,
      maxResolution: 2048,
      hiresFix: true,
      largeUpscale: 'enabled',
      livePreviews: 'full',
      autoUnloadInactive: false,
      modelCacheSize: 4,
      preloadCheckpoints: true,
      keepSingleModelOnGpu: false,
      moveIdleModelsOffGpu: false,
    },
    precisionOrder: ['fp16', 'fp32'],
    memoryOptimizations: { ...noOptimizations },
    vramBudgetMb: null,
    statusLabel: 'High performance mode',
  },
  cpu: {
    id: 'cpu',
    name: 'CPU Mode',
    description: 'No CUDA GPU detected or GPU disabled. Runs on the CPU in fp32 — slow but stable.',
    defaults: {
      batchSize: 1,
      concurrentGenerations: 1,
      parallelModelLoading: false,
      defaultResolution: 512,
      maxResolution: 768,
      hiresFix: false,
      largeUpscale: 'warn',
      livePreviews: 'reduced',
      autoUnloadInactive: true,
      modelCacheSize: 1,
      preloadCheckpoints: false,
      keepSingleModelOnGpu: false,
      moveIdleModelsOffGpu: false,
    },
    precisionOrder: ['fp32'],
    memoryOptimizations: {
      ...noOptimizations,
      attentionSlicing: true,
      vaeSlicing: true,
      vaeTiling: true,
    },
    vramBudgetMb: null,
    statusLabel: 'CPU mode active',
  },
};

/** Look up a concrete profile. `auto` must be resolved first (resolveEffectiveProfile). */
export function getHardwareProfile(id: EffectiveProfileId): HardwareProfile {
  return HARDWARE_PROFILES[id];
}

/** True for any id the registry (or `auto`) recognizes. */
export function isHardwareProfileId(value: unknown): value is HardwareProfileId {
  return typeof value === 'string' && (HARDWARE_PROFILE_IDS as string[]).includes(value);
}
