/**
 * Centralized model/workflow compatibility classification for a hardware profile.
 *
 * Classification is by architecture and workflow shape, NOT by file size. Only
 * constrained profiles (a VRAM budget) apply limits; unconstrained profiles keep
 * everything "recommended" so existing behavior is preserved.
 */
import type { ModelFamily } from '../shelf';
import { getHardwareProfile, type EffectiveProfileId } from './profiles';

export type CompatibilityCategory =
  | 'recommended'
  | 'compatible-limited'
  | 'cpu-offload-required'
  | 'high-oom-risk'
  | 'unsupported';

export interface CompatibilityInput {
  profileId: EffectiveProfileId;
  modelFamily: ModelFamily | 'Unknown';
  isVideo: boolean;
  controlNetCount: number;
  loraCount: number;
  refiner: boolean;
  upscaler: boolean;
}

export interface CompatibilityResult {
  category: CompatibilityCategory;
  label: string;
  reasons: string[];
}

const LABELS: Record<CompatibilityCategory, string> = {
  recommended: 'Recommended',
  'compatible-limited': 'Compatible with limitations',
  'cpu-offload-required': 'CPU offload required',
  'high-oom-risk': 'High risk of out-of-memory',
  unsupported: 'Unsupported in this mode',
};

export function classifyModelCompatibility(input: CompatibilityInput): CompatibilityResult {
  const profile = getHardwareProfile(input.profileId);
  const reasons: string[] = [];
  const result = (category: CompatibilityCategory): CompatibilityResult => ({
    category,
    label: LABELS[category],
    reasons,
  });

  // Unconstrained profiles (no VRAM budget) run everything — preserve behavior.
  if (profile.vramBudgetMb === null) return result('recommended');

  if (input.isVideo) {
    reasons.push('Video / animation workflows are not proven to fit this VRAM budget.');
    return result('unsupported');
  }

  if (input.modelFamily === 'Flux') {
    reasons.push('Flux does not fit this VRAM budget even with CPU offload.');
    return result('unsupported');
  }

  if (input.modelFamily === 'SDXL' || input.modelFamily === 'SD3') {
    if (input.refiner) {
      reasons.push('A refiner adds a second large model — very high OOM risk on this budget.');
      return result('high-oom-risk');
    }
    if (input.controlNetCount >= 2) {
      reasons.push('SDXL with multiple ControlNets is very likely to exceed the VRAM budget.');
      return result('high-oom-risk');
    }
    reasons.push(`${input.modelFamily} requires CPU offload to fit this VRAM budget.`);
    return result('cpu-offload-required');
  }

  if (input.modelFamily === 'Unknown') {
    reasons.push('Unknown architecture — treated cautiously.');
    return result('compatible-limited');
  }

  // SD1.5 baseline.
  if (input.controlNetCount >= 2 || input.loraCount >= 3 || input.refiner) {
    if (input.controlNetCount >= 2) reasons.push('Multiple ControlNets increase memory use.');
    if (input.loraCount >= 3) reasons.push('Multiple large LoRAs increase memory use.');
    return result('compatible-limited');
  }
  return result('recommended');
}
