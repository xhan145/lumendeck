import { findAsset, type ModelAsset } from './shelf';
import { expandWildcards, hasWildcards, mulberry32, type UsedWildcard, type WildcardSet } from './prompt/wildcards';
import type { ControlSlot, LoraSlot, Workflow } from './types';
import { findNode } from './workflow';

export interface ExportManifest {
  app: 'LumenDeck';
  appVersion: string;
  createdAt: string;
  prompt: string;
  negativePrompt: string;
  /** the wildcard-resolved positive prompt actually rendered (equals prompt when no wildcards). */
  resolvedPrompt: string;
  /** wildcards resolved for this render (empty when none). */
  wildcards: { token: string; value: string }[];
  seed: number;
  sampler: { name: string; steps: number; cfg: number };
  canvas: { width: number; height: number };
  media: { type: 'image' | 'video'; format: string; frameCount: number; fps: number };
  model: { id: string; name: string; family: string; hash: string } | null;
  loras: { id: string; name: string; weight: number; hash: string }[];
  /** ControlNet guidance used for this render (rack slots + legacy Apply ControlNet). */
  controlNets: { type: string; strength: number }[];
  graphVersion: number;
  graph: Workflow;
  render?: {
    selectedBackend: string;
    actualBackend: string;
    mode: 'real' | 'mock' | 'procedural' | 'fallback' | 'unknown';
    fallback: boolean;
    fallbackReason?: string;
    bridgeRenderer?: string;
  };
  /**
   * Present only for a motion-clip render: the animated source clip + sampling
   * parameters, so the sequence is reproducible from the base workflow (`graph`).
   */
  motion?: {
    clipId: string;
    clipName: string;
    frames: number;
    fps: number;
    durationSec: number;
  };
}

/** The motion descriptor `buildManifest` folds into a motion-render manifest. */
export interface ManifestMotion {
  clipId: string;
  clipName: string;
  frames: number;
  fps: number;
  durationSec: number;
}

export function buildManifest(
  wf: Workflow,
  shelf: ModelAsset[],
  appVersion: string,
  now: Date,
  wildcardSets: WildcardSet[] = [],
  motion?: ManifestMotion,
): ExportManifest {
  const prompt = findNode(wf, 'prompt');
  const sampler = findNode(wf, 'sampler');
  const canvas = findNode(wf, 'canvas');
  const video = findNode(wf, 'video');
  const exportNode = findNode(wf, 'export');
  const model = findNode(wf, 'model');
  const rack = findNode(wf, 'loraRack');

  const controlRack = findNode(wf, 'controlNetRack');
  const controlNetApply = findNode(wf, 'controlNetApply');
  const imageInput = findNode(wf, 'imageLoader');

  const checkpoint = model ? findAsset(shelf, String(model.params.assetId ?? '')) : undefined;
  const slots = ((rack?.params.slots as LoraSlot[] | undefined) ?? []).filter((s) => s.enabled);

  // Mirror buildRenderJob's collection: enabled rack slots with an image, then
  // the legacy singular controlNetApply + Load Image pairing when present.
  const controlNets = ((controlRack?.params.slots as ControlSlot[] | undefined) ?? [])
    .filter((s) => s.enabled && s.image)
    .map((s) => ({ type: s.type as string, strength: s.strength }));
  if (controlNetApply && imageInput?.params.image) {
    controlNets.push({
      type: String(controlNetApply.params.type ?? 'canny'),
      strength: Number(controlNetApply.params.strength ?? 1),
    });
  }

  const positive = String(prompt?.params.positive ?? '');
  const seed = Number(sampler?.params.seed ?? -1);
  // Mirror buildRenderJob: resolve wildcards seeded by the render seed so the
  // manifest documents the exact text that made the image. No tokens → identical.
  const expansion = hasWildcards(positive)
    ? expandWildcards(positive, wildcardSets, mulberry32(seed >= 0 ? Math.floor(seed) : 0))
    : { resolved: positive, used: [] as UsedWildcard[], unknown: [] as string[] };

  return {
    app: 'LumenDeck',
    appVersion,
    createdAt: now.toISOString(),
    prompt: positive,
    negativePrompt: String(prompt?.params.negative ?? ''),
    resolvedPrompt: expansion.resolved,
    wildcards: expansion.used.map((w) => ({ token: w.token, value: w.value })),
    seed,
    sampler: {
      name: String(sampler?.params.sampler ?? 'euler_a'),
      steps: Number(sampler?.params.steps ?? 0),
      cfg: Number(sampler?.params.cfg ?? 0),
    },
    canvas: {
      width: Number(canvas?.params.width ?? 0),
      height: Number(canvas?.params.height ?? 0),
    },
    media: {
      type: video?.params.enabled ? 'video' : 'image',
      format: String(exportNode?.params.format ?? (video?.params.enabled ? 'gif' : 'png')),
      frameCount: Number(video?.params.frameCount ?? 1),
      fps: Number(video?.params.fps ?? 0),
    },
    model: checkpoint
      ? { id: checkpoint.id, name: checkpoint.name, family: checkpoint.family, hash: checkpoint.hash }
      : null,
    loras: slots.map((s) => {
      const asset = findAsset(shelf, s.assetId);
      return {
        id: s.assetId,
        name: asset?.name ?? s.assetId,
        weight: s.weight,
        hash: asset?.hash ?? 'unknown',
      };
    }),
    controlNets,
    graphVersion: wf.version,
    graph: wf,
    // Motion-render manifests also carry the animated clip fields (spec §"Data
    // flow & manifest"); omitted entirely for ordinary image/video renders.
    ...(motion ? { motion } : {}),
  };
}
