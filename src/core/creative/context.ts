/**
 * The read-only view of app state the analysis engines (missing / entropy /
 * next-action / critic) operate over. Kept deliberately narrow so the engines
 * stay pure and unit-testable without the Zustand store or IndexedDB.
 */
import type { AspectKey } from './types';

/** A render's metadata, projected from a GalleryItem for analysis. */
export interface RenderInfo {
  id: string;
  createdAt: string;
  aspect: AspectKey | 'other';
  /** true when the render has a collection or at least one tag */
  labeled: boolean;
  /** dedupe signature — same prompt+seed+size => likely duplicate */
  signature: string;
  /** the render's positive prompt (for lineage matching) */
  prompt: string;
  /** whether this render is still referenced by any project */
  linkedToProject: boolean;
  /** ---- craft-brain fields (optional; other engines ignore them) ---- */
  /** model family from the manifest (e.g. 'SDXL', 'Pony'); '' if none */
  modelFamily?: string;
  /** sampler name from the manifest */
  sampler?: string;
  /** sampler steps */
  steps?: number;
  /** cfg scale */
  cfg?: number;
  /** the render's negative prompt */
  negativePrompt?: string;
  /** true for mock/procedural fallback renders — excluded from the craft corpus */
  fallback?: boolean;
  /** curated-actions signal: linkedToProject OR labeled */
  kept?: boolean;
}

export interface AnalysisContext {
  /** every render known to the gallery, projected for analysis */
  renders: RenderInfo[];
  /** shelf model ids that actually exist (for broken-model detection) */
  knownModelIds: Set<string>;
}

/** Classify pixel dimensions into an aspect slot (tolerant of small rounding). */
export function classifyAspect(width: number, height: number): AspectKey | 'other' {
  if (width <= 0 || height <= 0) return 'other';
  const r = width / height;
  if (Math.abs(r - 16 / 9) < 0.06) return '16:9';
  if (Math.abs(r - 1) < 0.06) return '1:1';
  if (Math.abs(r - 9 / 16) < 0.06) return '9:16';
  return 'other';
}

export function emptyContext(): AnalysisContext {
  return { renders: [], knownModelIds: new Set() };
}

/** Fast lookup by render id. */
export function indexRenders(ctx: AnalysisContext): Map<string, RenderInfo> {
  const m = new Map<string, RenderInfo>();
  for (const r of ctx.renders) m.set(r.id, r);
  return m;
}
