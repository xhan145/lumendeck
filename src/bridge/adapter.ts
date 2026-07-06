import type { ControlSlot, LoraSlot, Workflow } from '../core/types';
import type { PipelineTimings } from '../turboForge/types';
import { findNode } from '../core/workflow';
import { expandWildcards, hasWildcards, mulberry32, type UsedWildcard, type WildcardSet } from '../core/prompt/wildcards';

export interface RenderJob {
  prompt: string;
  negativePrompt: string;
  seed: number;
  steps: number;
  cfg: number;
  denoise: number;
  scheduler: string;
  width: number;
  height: number;
  modelId: string | null;
  loras: { id: string; weight: number }[];
  sampler: string;
  output: 'image' | 'video';
  frameCount: number;
  fps: number;
  motionStrength: number;
  cameraMotion: string;
  loop: boolean;
  format: string;
  initImage?: string;
  maskImage?: string;
  denoiseStrength: number;
  hiresScale: number;
  hiresDenoise: number;
  hiresSteps: number;
  controlNet?: { model: string; strength: number; image: string };
  /**
   * MultiControlNet stack. 'model' carries the TYPE string
   * ('canny'|'depth'|'pose'|'scribble'|'lineart'|'softedge'|'tile'), matching
   * the legacy singular controlNet convention above.
   */
  controlNets?: Array<{ model: string; strength: number; image: string }>;
  /**
   * The wildcard-resolved positive prompt actually sent to the backend. When the
   * original prompt has no `__token__` wildcards this equals `prompt` exactly, so
   * behavior is identical to before this feature.
   */
  resolvedPrompt: string;
  /** wildcards resolved for this job (empty when none were present). */
  usedWildcards: UsedWildcard[];
}

export interface RenderResult {
  dataUrl: string;
  mediaType: 'image' | 'video';
  mimeType: string;
  extension: string;
  /** actual seed used (resolved when job seed is -1) */
  seed: number;
  backendTimings?: PipelineTimings;
  /** true when a real render was expected but the backend fell back to procedural */
  fallback?: boolean;
  fallbackReason?: string;
  /** controls the backend skipped because the loaded model family has no weights for them */
  droppedControls?: { type: string; reason: string }[];
}

export interface RenderProgress {
  progress: number;
  phase?: string;
  detail?: string;
  previewDataUrl?: string;
}

export type RenderProgressUpdate = number | RenderProgress;
export type RenderProgressCallback = (update: RenderProgressUpdate) => void;

export function normalizeProgress(update: RenderProgressUpdate): RenderProgress {
  return typeof update === 'number' ? { progress: update } : update;
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
  generate(job: RenderJob, onProgress?: RenderProgressCallback): Promise<RenderResult>;
}

export function buildRenderJob(wf: Workflow, wildcardSets: WildcardSet[] = []): RenderJob {
  const prompt = findNode(wf, 'prompt');
  const sampler = findNode(wf, 'sampler');
  const canvas = findNode(wf, 'canvas');
  const model = findNode(wf, 'model');
  const rack = findNode(wf, 'loraRack');
  const video = findNode(wf, 'video');
  const imageInput = findNode(wf, 'imageLoader');
  const controlNet = findNode(wf, 'controlNetApply');
  const hires = findNode(wf, 'hiresFix');
  const exportNode = findNode(wf, 'export');
  const controlRack = findNode(wf, 'controlNetRack');
  const slots = ((rack?.params.slots as LoraSlot[] | undefined) ?? []).filter((s) => s.enabled);
  const videoEnabled = Boolean(video?.params.enabled);
  const exportFormat = String(exportNode?.params.format ?? '');

  // ControlNet stack: enabled rack slots that carry a control image, followed by
  // the legacy singular controlNetApply + Load Image pairing when present.
  const controlEntries = ((controlRack?.params.slots as ControlSlot[] | undefined) ?? [])
    .filter((s) => s.enabled && s.image)
    .map((s) => ({ model: s.type as string, strength: s.strength, image: s.image }));
  if (controlNet && imageInput?.params.image) {
    controlEntries.push({
      model: String(controlNet.params.type ?? 'canny'),
      strength: Number(controlNet.params.strength ?? 1),
      image: String(imageInput.params.image),
    });
  }

  const positive = String(prompt?.params.positive ?? '');
  const seed = Number(sampler?.params.seed ?? -1);
  // Resolve wildcards seeded by the render seed so a re-render with the SAME
  // fixed seed resolves identically (spec acceptance #2). A random seed (-1) has
  // no reproducible target, so it draws a fresh per-call seed for the picks.
  // IMPORTANT: with no tokens present, resolved === positive (identical behavior).
  const resolvedSeed = resolveSeed(seed);
  const expansion = hasWildcards(positive)
    ? expandWildcards(positive, wildcardSets, mulberry32(resolvedSeed))
    : { resolved: positive, used: [] as UsedWildcard[], unknown: [] as string[] };

  return {
    prompt: expansion.resolved,
    negativePrompt: String(prompt?.params.negative ?? ''),
    seed,
    resolvedPrompt: expansion.resolved,
    usedWildcards: expansion.used,
    steps: Number(sampler?.params.steps ?? 28),
    cfg: Number(sampler?.params.cfg ?? 7),
    denoise: Number(sampler?.params.denoise ?? 1),
    scheduler: String(sampler?.params.scheduler ?? 'karras'),
    width: Number(canvas?.params.width ?? 1024),
    height: Number(canvas?.params.height ?? 1024),
    modelId: (model?.params.assetId as string) || null,
    loras: slots.map((s) => ({ id: s.assetId, weight: s.weight })),
    sampler: String(sampler?.params.sampler ?? 'euler_a'),
    output: videoEnabled ? 'video' : 'image',
    frameCount: Number(video?.params.frameCount ?? 1),
    fps: Number(video?.params.fps ?? 8),
    motionStrength: Number(video?.params.motionStrength ?? 0),
    cameraMotion: String(video?.params.cameraMotion ?? 'orbit'),
    loop: Boolean(video?.params.loop ?? true),
    format: videoEnabled ? 'gif' : (exportFormat || 'png'),
    // img2img/inpaint: an uploaded image (base64) on the Load Image capsule.
    initImage: (imageInput?.params.image as string) || undefined,
    maskImage: (imageInput?.params.mask as string) || undefined,
    denoiseStrength: Number(imageInput?.params.strength ?? 0.6),
    // hires fix: a second upscale+denoise pass when the Hires Fix capsule is present.
    hiresScale: Number(hires?.params.scale ?? 1),
    hiresDenoise: Number(hires?.params.denoise ?? 0.35),
    hiresSteps: Number(hires?.params.steps ?? 14),
    // ControlNet: the full stack when any controls are present; the first entry
    // is mirrored into the legacy singular field for old-sidecar compatibility.
    controlNets: controlEntries.length > 0 ? controlEntries : undefined,
    controlNet: controlEntries.length > 0 ? controlEntries[0] : undefined,
  };
}

/** Resolve seed -1 → random 32-bit seed; otherwise pass through. */
export function resolveSeed(seed: number, rand: () => number = Math.random): number {
  return seed >= 0 ? Math.floor(seed) : Math.floor(rand() * 0xffffffff);
}
