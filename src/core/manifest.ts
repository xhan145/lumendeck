import { findAsset, type ModelAsset } from './shelf';
import type { LoraSlot, Workflow } from './types';
import { findNode } from './workflow';

export interface ExportManifest {
  app: 'LumenDeck';
  appVersion: string;
  createdAt: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  sampler: { name: string; steps: number; cfg: number };
  canvas: { width: number; height: number };
  media: { type: 'image' | 'video'; format: string; frameCount: number; fps: number };
  model: { id: string; name: string; family: string; hash: string } | null;
  loras: { id: string; name: string; weight: number; hash: string }[];
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
}

export function buildManifest(
  wf: Workflow,
  shelf: ModelAsset[],
  appVersion: string,
  now: Date,
): ExportManifest {
  const prompt = findNode(wf, 'prompt');
  const sampler = findNode(wf, 'sampler');
  const canvas = findNode(wf, 'canvas');
  const video = findNode(wf, 'video');
  const exportNode = findNode(wf, 'export');
  const model = findNode(wf, 'model');
  const rack = findNode(wf, 'loraRack');

  const checkpoint = model ? findAsset(shelf, String(model.params.assetId ?? '')) : undefined;
  const slots = ((rack?.params.slots as LoraSlot[] | undefined) ?? []).filter((s) => s.enabled);

  return {
    app: 'LumenDeck',
    appVersion,
    createdAt: now.toISOString(),
    prompt: String(prompt?.params.positive ?? ''),
    negativePrompt: String(prompt?.params.negative ?? ''),
    seed: Number(sampler?.params.seed ?? -1),
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
    graphVersion: wf.version,
    graph: wf,
  };
}
