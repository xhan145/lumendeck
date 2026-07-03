import { findAsset, loraCompatible, type ModelAsset } from '../core/shelf';
import type { LoraSlot, RackPreset } from '../core/types';
import type { LoraStackPreset, ModelCapability, TurboLora } from './types';

export function activeTurboLoras(slots: LoraSlot[], shelf: ModelAsset[], model: ModelCapability | null): TurboLora[] {
  const checkpoint = model ? findAsset(shelf, model.id) : undefined;
  return slots
    .filter((slot) => slot.enabled)
    .map((slot) => {
      const asset = findAsset(shelf, slot.assetId);
      const compatibility = asset && checkpoint ? loraCompatible(asset, checkpoint) : { ok: false, warning: 'Select a model to check LoRA compatibility.' };
      return {
        ...slot,
        name: asset?.name ?? slot.assetId,
        path: asset?.path ?? '',
        hash: asset?.hash ?? 'unknown',
        family: asset?.family ?? 'SDXL',
        compatible: compatibility.ok,
        warning: compatibility.warning,
      };
    });
}

export function loraOverheadMs(loras: TurboLora[]): number {
  return loras.reduce((sum, lora) => sum + 25 + Math.abs(lora.weight) * 15, 0);
}

export function saveLoraStackPreset(id: string, name: string, loras: TurboLora[]): LoraStackPreset {
  return { id, name, loras: loras.map((lora) => ({ ...lora })) };
}

export function rackPresetToTurboPreset(preset: RackPreset, shelf: ModelAsset[], model: ModelCapability | null): LoraStackPreset {
  return saveLoraStackPreset(preset.id, preset.name, activeTurboLoras(preset.slots, shelf, model));
}

export function loraWarnings(loras: TurboLora[], model: ModelCapability | null): string[] {
  const warnings = loras.flatMap((lora) => (lora.warning ? [lora.warning] : []));
  if (loras.length > 3) warnings.push('Large LoRA stacks can add setup overhead; save common combinations as presets.');
  if (model && !model.loraSupport && loras.length) warnings.push(`${model.displayName} does not advertise LoRA support.`);
  return warnings;
}
