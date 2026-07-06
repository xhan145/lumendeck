import { CAPSULES } from '../../core/capsules';
import type { CapsuleKind } from '../../core/types';

/**
 * One-line status text shown under a graph node card.
 * Shared by the 2D (GraphView) and 3D (Graph3DView) graph editors.
 */
export function nodeSummary(kind: CapsuleKind, params: Record<string, unknown>): string {
  switch (kind) {
    case 'prompt': return String(params.positive ?? '').slice(0, 60) || 'No prompt';
    case 'model': return params.assetId ? String(params.assetId) : 'No checkpoint';
    case 'loraRack': return `${Array.isArray(params.slots) ? params.slots.length : 0} LoRA slots`;
    case 'controlNetRack': return `${Array.isArray(params.slots) ? params.slots.length : 0} control slots`;
    case 'checkpointLoader': return String(params.checkpoint ?? 'model.safetensors');
    case 'clipTextEncode': return String(params.text ?? '').slice(0, 60) || 'No text';
    case 'sampler': return `${params.sampler} | ${params.steps} steps | cfg ${params.cfg}`;
    case 'samplerAdvanced': return `${params.startStep}-${params.endStep} steps | noise ${params.addNoise ? 'on' : 'off'}`;
    case 'video': return params.enabled ? `${params.frameCount} frames @ ${params.fps} fps | ${params.cameraMotion}` : 'Disabled';
    case 'canvas': return `${params.width}x${params.height} x${params.batch}`;
    case 'control': return params.enabled ? `${params.mode} @ ${params.strength}` : 'Disabled';
    case 'imageLoader': {
      if (!params.image) return 'No image — drop one here';
      const base = `img2img @ ${Number(params.strength ?? 0.6)}`;
      return params.mask ? `${base} + mask` : base;
    }
    case 'note': return String(params.body ?? '').slice(0, 60) || 'Empty note';
    default: return CAPSULES[kind].description;
  }
}
