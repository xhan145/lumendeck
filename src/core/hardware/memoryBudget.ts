/**
 * Centralized VRAM memory-budget policy.
 *
 * A single deterministic estimator instead of scattered GPU-name checks. It
 * returns a structured verdict (safe / warning / blocked) plus human reasons and
 * concrete recommended changes. The number is an ESTIMATE (isEstimate: true) —
 * never presented as a measurement — but it is deterministic and testable.
 */
import type { ModelFamily } from '../shelf';
import { getHardwareProfile, type EffectiveProfileId } from './profiles';

export type BudgetStatus = 'safe' | 'warning' | 'blocked';

export type BudgetVaeMode = 'default' | 'sliced' | 'tiled';

export interface MemoryBudgetRequest {
  profileId: EffectiveProfileId;
  modelFamily: ModelFamily | 'Unknown';
  width: number;
  height: number;
  batchSize: number;
  controlNetCount: number;
  loraCount: number;
  vaeMode: BudgetVaeMode;
  /** A large/standalone upscale operation is part of the workflow. */
  upscaler: boolean;
  refiner: boolean;
  livePreview: boolean;
  /** Whether model CPU offload will be applied (lowers resident weight cost). */
  cpuOffload: boolean;
}

export interface MemoryBudgetResult {
  status: BudgetStatus;
  estimatedVramMb: number;
  reasons: string[];
  recommendedChanges: string[];
  /** Always true — this is a deterministic estimate, not a measurement. */
  isEstimate: true;
}

/** Resident checkpoint weights in MB (fp16), before any offload. */
const BASE_WEIGHTS_MB: Record<MemoryBudgetRequest['modelFamily'], number> = {
  'SD1.5': 1600,
  SDXL: 5200,
  SD3: 6500,
  Flux: 13000,
  Unknown: 2400,
};

/** Activation cost per megapixel per batch item, MB. */
const ACT_PER_MP_MB: Record<MemoryBudgetRequest['modelFamily'], number> = {
  'SD1.5': 1000,
  SDXL: 900,
  SD3: 1000,
  Flux: 1100,
  Unknown: 1000,
};

/** Resident ControlNet weight in MB (fp16), before offload. */
const CONTROLNET_MB: Record<MemoryBudgetRequest['modelFamily'], number> = {
  'SD1.5': 700,
  SDXL: 1250,
  SD3: 1250,
  Flux: 1400,
  Unknown: 900,
};

/** Fraction of resident weights that stay on the GPU when CPU offload is active. */
const OFFLOAD_RESIDENT_FRACTION = 0.3;
/** Baseline CUDA context / allocator overhead, MB. */
const CUDA_CONTEXT_MB = 350;

const LARGE_FAMILIES = new Set(['SDXL', 'SD3', 'Flux']);

function round(n: number): number {
  return Math.round(n);
}

export function estimateVramBudget(req: MemoryBudgetRequest): MemoryBudgetResult {
  const profile = getHardwareProfile(req.profileId);
  const budget = profile.vramBudgetMb;

  const offloadFactor = req.cpuOffload ? OFFLOAD_RESIDENT_FRACTION : 1;
  const megapixels = Math.max(0, (req.width * req.height) / 1_000_000);
  const batch = Math.max(1, req.batchSize);

  const weights = BASE_WEIGHTS_MB[req.modelFamily] * offloadFactor;
  const activations = megapixels * batch * ACT_PER_MP_MB[req.modelFamily];
  const controlNets = req.controlNetCount * CONTROLNET_MB[req.modelFamily] * offloadFactor;
  const loras = req.loraCount * 150;
  const refiner = req.refiner ? BASE_WEIGHTS_MB[req.modelFamily] * offloadFactor : 0;
  // A large upscale spike is bounded by tiling; still costs some temporary memory.
  const upscaler = req.upscaler ? (req.vaeMode === 'tiled' ? 300 : 1200) : 0;
  const preview = req.livePreview ? 200 : 0;

  const estimatedVramMb = round(
    weights + activations + controlNets + loras + refiner + upscaler + preview + CUDA_CONTEXT_MB,
  );

  const reasons: string[] = [];
  const recommendedChanges: string[] = [];
  const add = (reason: string, change?: string) => {
    reasons.push(reason);
    if (change && !recommendedChanges.includes(change)) recommendedChanges.push(change);
  };

  // Profiles without an explicit budget (high performance, CPU) never nag — this
  // preserves existing behavior for users who did not opt into a low-VRAM mode.
  if (budget === null) {
    return { status: 'safe', estimatedVramMb, reasons: [], recommendedChanges: [], isEstimate: true };
  }

  // Qualitative rules — each raises the floor to at least a warning.
  if (LARGE_FAMILIES.has(req.modelFamily)) {
    if (req.cpuOffload) {
      add(`${req.modelFamily} requires CPU offload on a ${Math.round(budget / 1024)}GB GPU.`);
    } else {
      add(
        `${req.modelFamily} does not fit a ${Math.round(budget / 1024)}GB GPU without CPU offload.`,
        'Enable model CPU offload',
      );
    }
    // Always surface the offload recommendation for large families.
    if (!recommendedChanges.includes('Enable model CPU offload')) {
      recommendedChanges.push('Enable model CPU offload');
    }
  }

  const maxRes = profile.defaults.maxResolution;
  if (req.width > maxRes || req.height > maxRes) {
    add(
      `Resolution ${req.width}x${req.height} exceeds the ${maxRes}x${maxRes} limit for the ${profile.name} profile.`,
      `Reduce resolution to ${profile.defaults.defaultResolution}x${profile.defaults.defaultResolution}`,
    );
  }

  if (batch > 1) {
    add(`Batch size ${batch} multiplies activation memory; images render sequentially.`, 'Reduce batch size to 1');
  }

  if (req.controlNetCount >= 2) {
    add(`${req.controlNetCount} ControlNet models exceed the recommended budget.`, 'Use one ControlNet');
  }

  if (req.loraCount >= 2) {
    add(`${req.loraCount} large LoRAs increase memory use.`, 'Reduce the number of LoRAs');
  }

  if (req.refiner) {
    add('Refiners are disabled by default on low-VRAM GPUs.', 'Disable the refiner');
  }

  if (req.upscaler) {
    add('Large upscale operations run tiled or on the CPU on low-VRAM GPUs.');
  }

  // status: blocked if the estimate overruns the budget even after offload,
  // otherwise warning if any qualitative concern, otherwise safe.
  let status: BudgetStatus;
  if (estimatedVramMb > budget) {
    status = 'blocked';
    if (!reasons.some((r) => /exceed|fit|budget/i.test(r))) {
      add(`Estimated ${estimatedVramMb} MB exceeds the ${budget} MB budget.`, 'Reduce resolution, batch size, or extra models');
    }
  } else if (reasons.length > 0) {
    status = 'warning';
  } else {
    status = 'safe';
  }

  return { status, estimatedVramMb, reasons, recommendedChanges, isEstimate: true };
}
