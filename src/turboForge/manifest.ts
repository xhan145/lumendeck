import type { ExportManifest } from '../core/manifest';
import type { TurboForgeManifestData } from './types';

export function withTurboForgeManifest(
  manifest: ExportManifest,
  turboForge: TurboForgeManifestData,
): ExportManifest & { turboForge: TurboForgeManifestData } {
  return { ...manifest, turboForge };
}
