export type ModelFamily = 'SD1.5' | 'SDXL' | 'SD3' | 'Flux';

export interface ModelAsset {
  id: string;
  assetType: 'checkpoint' | 'lora';
  name: string;
  family: ModelFamily;
  path: string;
  hash: string;
  sizeMB: number;
  tags: string[];
  compatibility: string;
  license: string;
  installed: boolean;
}

export function findAsset(shelf: ModelAsset[], id: string): ModelAsset | undefined {
  return shelf.find((a) => a.id === id);
}

export function loraCompatible(
  lora: ModelAsset,
  checkpoint: ModelAsset,
): { ok: boolean; warning?: string } {
  if (lora.family === checkpoint.family) return { ok: true };
  return {
    ok: false,
    warning: `${lora.name} targets ${lora.family} but the checkpoint is ${checkpoint.family} — results will likely be corrupted.`,
  };
}
