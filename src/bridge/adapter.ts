import type { LoraSlot, Workflow } from '../core/types';
import type { PipelineTimings } from '../turboForge/types';
import { findNode } from '../core/workflow';

export interface RenderJob {
  prompt: string;
  negativePrompt: string;
  seed: number;
  steps: number;
  cfg: number;
  width: number;
  height: number;
  modelId: string | null;
  loras: { id: string; weight: number }[];
  sampler: string;
}

export interface RenderResult {
  dataUrl: string;
  /** actual seed used (resolved when job seed is -1) */
  seed: number;
  backendTimings?: PipelineTimings;
  /** true when a real render was expected but the backend fell back to procedural */
  fallback?: boolean;
  fallbackReason?: string;
}

/**
 * Boundary between LumenDeck and any generation backend. Implementations:
 * MockAdapter (in-browser procedural), HttpAdapter (local FastAPI bridge),
 * and future A1111/ComfyUI adapters.
 */
export interface BackendAdapter {
  id: string;
  label: string;
  ping(): Promise<boolean>;
  generate(job: RenderJob, onProgress?: (p: number) => void): Promise<RenderResult>;
}

export function buildRenderJob(wf: Workflow): RenderJob {
  const prompt = findNode(wf, 'prompt');
  const sampler = findNode(wf, 'sampler');
  const canvas = findNode(wf, 'canvas');
  const model = findNode(wf, 'model');
  const rack = findNode(wf, 'loraRack');
  const slots = ((rack?.params.slots as LoraSlot[] | undefined) ?? []).filter((s) => s.enabled);

  return {
    prompt: String(prompt?.params.positive ?? ''),
    negativePrompt: String(prompt?.params.negative ?? ''),
    seed: Number(sampler?.params.seed ?? -1),
    steps: Number(sampler?.params.steps ?? 28),
    cfg: Number(sampler?.params.cfg ?? 7),
    width: Number(canvas?.params.width ?? 1024),
    height: Number(canvas?.params.height ?? 1024),
    modelId: (model?.params.assetId as string) || null,
    loras: slots.map((s) => ({ id: s.assetId, weight: s.weight })),
    sampler: String(sampler?.params.sampler ?? 'euler_a'),
  };
}

/** Resolve seed -1 → random 32-bit seed; otherwise pass through. */
export function resolveSeed(seed: number, rand: () => number = Math.random): number {
  return seed >= 0 ? Math.floor(seed) : Math.floor(rand() * 0xffffffff);
}
