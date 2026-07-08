/**
 * Creative OS state slice: project brains + creative recipes + the analysis
 * context projection. Follows the house slice pattern (type + defaultX +
 * hydrateX with additive, defensive migration) so pre-Creative-OS saved state
 * still loads.
 */
import type { GalleryItem } from './store';
import type { ModelAsset } from '../core/shelf';
import type { CreativeRecipe, ProjectBrain } from '../core/creative/types';
import { sanitizeBrain } from '../core/creative/brain';
import { sanitizeRecipe } from '../core/creative/recipes';
import { classifyAspect, type AnalysisContext, type RenderInfo } from '../core/creative/context';

export interface CreativeState {
  brains: ProjectBrain[];
  recipes: CreativeRecipe[];
  /** the project currently focused in project-detail surfaces */
  activeProjectId: string | null;
  /** opt-in AI enhancement flag — OFF by default (local-first requirement) */
  aiEnabled: boolean;
  /** true once demo data has been offered/seeded, so we never re-seed */
  seeded: boolean;
}

export function defaultCreativeState(): CreativeState {
  return { brains: [], recipes: [], activeProjectId: null, aiEnabled: false, seeded: false };
}

/** The persisted shape (identical here, but kept explicit for the projection). */
export type PersistedCreative = Partial<CreativeState>;

export function hydrateCreative(persisted: PersistedCreative | undefined): CreativeState {
  if (!persisted) return defaultCreativeState();
  const brains = Array.isArray(persisted.brains) ? persisted.brains.map((b) => sanitizeBrain(b)) : [];
  const recipes = Array.isArray(persisted.recipes) ? persisted.recipes.map((r) => sanitizeRecipe(r)) : [];
  const activeProjectId =
    typeof persisted.activeProjectId === 'string' && brains.some((b) => b.id === persisted.activeProjectId)
      ? persisted.activeProjectId
      : brains[0]?.id ?? null;
  return {
    brains,
    recipes,
    activeProjectId,
    aiEnabled: persisted.aiEnabled === true,
    seeded: persisted.seeded === true,
  };
}

/**
 * Project the live gallery + brains into the read-only AnalysisContext the pure
 * engines consume. Renders stay in IndexedDB — this only reads their metadata.
 */
export function buildAnalysisContext(
  gallery: GalleryItem[],
  brains: ProjectBrain[],
  shelf: ModelAsset[],
): AnalysisContext {
  const linked = new Set<string>();
  for (const b of brains) {
    for (const id of b.renders) linked.add(id);
    for (const a of b.assets) if (a.galleryId) linked.add(a.galleryId);
  }
  const renders: RenderInfo[] = gallery.map((g) => {
    const canvas = g.manifest?.canvas ?? { width: 0, height: 0 };
    const prompt = g.manifest?.resolvedPrompt || g.manifest?.prompt || '';
    const seed = g.manifest?.seed ?? 0;
    return {
      id: g.id,
      createdAt: g.createdAt,
      aspect: classifyAspect(canvas.width, canvas.height),
      labeled: Boolean(g.collectionId) || (g.tags?.length ?? 0) > 0,
      signature: `${prompt}|${seed}|${canvas.width}x${canvas.height}`,
      prompt,
      linkedToProject: linked.has(g.id),
    };
  });
  return { renders, knownModelIds: new Set(shelf.map((m) => m.id)) };
}
