import type { ExportManifest } from './manifest';

export interface RenderHonestyLike {
  fallback?: boolean;
  fallbackReason?: string;
  actualBackend?: string;
  selectedBackend?: string;
  renderMode?: string;
  manifest?: Pick<ExportManifest, 'render'> & { turboForge?: { backendId?: string; warnings?: { code?: string; message?: string }[] } };
}

function renderMeta(item: RenderHonestyLike) {
  return item.manifest?.render;
}

export function isFallbackRender(item: RenderHonestyLike): boolean {
  const meta = renderMeta(item);
  if (item.fallback || meta?.fallback) return true;
  if (item.renderMode === 'fallback' || meta?.mode === 'fallback') return true;
  return item.manifest?.turboForge?.warnings?.some((warning) => warning.code === 'backend-fallback') ?? false;
}

/**
 * A render that must NOT be treated as real-model output: an actual fallback, OR a
 * mock/procedural render (the mock backend is the DEFAULT). Analysis that mines "what a
 * real model produced" (e.g. the craft brain) must exclude these so placeholder renders
 * never masquerade as validated signal.
 */
export function isSyntheticRender(item: RenderHonestyLike): boolean {
  if (isFallbackRender(item)) return true;
  const mode = renderMeta(item)?.mode ?? item.renderMode;
  return mode === 'mock' || mode === 'procedural';
}

export function fallbackReasonFor(item: RenderHonestyLike): string {
  const meta = renderMeta(item);
  if (item.fallbackReason) return item.fallbackReason;
  if (meta?.fallbackReason) return meta.fallbackReason;
  const warning = item.manifest?.turboForge?.warnings?.find((w) => w.code === 'backend-fallback');
  return warning?.message ?? (isFallbackRender(item) ? 'The selected real backend could not complete the render.' : '');
}

export function renderBackendLabel(item: RenderHonestyLike): string {
  const meta = renderMeta(item);
  const actual = item.actualBackend ?? meta?.actualBackend ?? item.manifest?.turboForge?.backendId;
  const selected = item.selectedBackend ?? meta?.selectedBackend;
  const mode = item.renderMode ?? meta?.mode;
  if (isFallbackRender(item)) return actual ? `Fallback: ${actual}` : 'Fallback render';
  if (mode === 'mock') return 'Mock renderer';
  if (mode === 'procedural') return 'Procedural renderer';
  if (actual && selected && actual !== selected) return `${actual} via ${selected}`;
  return actual ?? selected ?? 'Unknown backend';
}

export function renderModeLabel(item: RenderHonestyLike): string {
  const mode = item.renderMode ?? renderMeta(item)?.mode;
  if (isFallbackRender(item)) return 'Fallback';
  if (mode === 'real') return 'Real model';
  if (mode === 'procedural') return 'Procedural';
  if (mode === 'mock') return 'Mock';
  return 'Unknown';
}
