import { estimateVramGB } from '../core/health';
import type { ModelAsset } from '../core/shelf';
import type { ModelCapability, TurboPresetId, TurboTask } from './types';

export function capabilityFromAsset(asset: ModelAsset): ModelCapability {
  const isVideo = asset.tags.some((tag) => /video|ltx|hunyuan/i.test(tag));
  const taskTypes: TurboTask[] = asset.assetType === 'lora'
    ? ['text-to-image', 'image-to-image']
    : ['text-to-image', 'image-to-image', ...(isVideo ? (['text-to-video', 'image-to-video', 'video-to-video'] as TurboTask[]) : [])];
  const recommendedPreset: TurboPresetId = asset.family === 'Flux' || asset.sizeMB > 12000 ? 'eco' : 'fast';
  return {
    id: asset.id,
    displayName: asset.name,
    family: asset.family,
    taskTypes,
    localPath: asset.path,
    fileHash: asset.hash,
    licenseNotes: asset.license,
    vramEstimateGB: estimateVramGB(1024, 1024, 1, asset.family),
    supportedResolutions: asset.family === 'SD1.5' ? ['512x512', '768x768'] : ['768x768', '1024x1024', '1344x768'],
    supportedPrecisionModes: asset.family === 'SD1.5' ? ['fp32', 'fp16'] : ['fp32', 'fp16', 'bf16'],
    loraSupport: asset.assetType === 'checkpoint',
    conditioningSupport: asset.assetType === 'checkpoint',
    compileSupport: asset.assetType === 'checkpoint' && asset.installed,
    tensorRtSupport: asset.assetType === 'checkpoint' && asset.installed && asset.family !== 'SD3',
    onnxSupport: asset.assetType === 'checkpoint' && asset.installed,
    videoSupport: isVideo,
    knownIncompatibilities: asset.installed ? [] : ['Model is not installed locally.'],
    recommendedPreset,
  };
}

export function buildCapabilityMatrix(shelf: ModelAsset[]): ModelCapability[] {
  return shelf.filter((asset) => asset.assetType === 'checkpoint').map(capabilityFromAsset);
}

export function validateModelCapability(capability: ModelCapability): string[] {
  const issues: string[] = [];
  if (!capability.id) issues.push('Missing model id.');
  if (!capability.fileHash) issues.push('Missing model hash.');
  if (capability.supportedResolutions.length === 0) issues.push('No supported resolutions declared.');
  if (capability.supportedPrecisionModes.length === 0) issues.push('No precision modes declared.');
  if (capability.taskTypes.length === 0) issues.push('No task types declared.');
  return issues;
}

export function findCapability(matrix: ModelCapability[], id: string | null): ModelCapability | null {
  if (!id) return null;
  return matrix.find((capability) => capability.id === id) ?? null;
}
