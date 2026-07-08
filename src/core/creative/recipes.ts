/**
 * Creative recipe lifecycle: create / duplicate / apply. Pure module — callers
 * pass `now` for deterministic timestamps (buildManifest convention).
 *
 * A recipe is a reusable prompt/style/model scaffold. "Applying" a recipe does
 * not itself render — it resolves the recipe into a concrete workflow patch
 * (prompt text, negative, canvas size, model id) that the store commits to the
 * live workflow, then bumps usage stats.
 */
import { ASPECT_PRESETS, type AspectKey, type CreativeRecipe } from './types';
import { creativeId } from './brain';

export function createRecipe(name: string, now: Date, partial?: Partial<CreativeRecipe>): CreativeRecipe {
  const at = now.toISOString();
  const base: CreativeRecipe = {
    id: creativeId('rec'),
    name: name.trim() || 'Untitled Recipe',
    persona: '',
    styleTags: [],
    modelId: '',
    promptTemplate: '',
    negativePrompt: '',
    aspectRatios: ['1:1'],
    exportTargets: [],
    brandColors: [],
    successScore: 0,
    timesUsed: 0,
    lastUsedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  // Merge caller overrides, but id/timestamps stay engine-owned.
  return { ...base, ...partial, id: base.id, createdAt: at, updatedAt: at };
}

export function duplicateRecipe(recipe: CreativeRecipe, now: Date): CreativeRecipe {
  const at = now.toISOString();
  return {
    ...recipe,
    id: creativeId('rec'),
    name: `${recipe.name} copy`,
    timesUsed: 0,
    lastUsedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function updateRecipe(recipe: CreativeRecipe, patch: Partial<CreativeRecipe>, now: Date): CreativeRecipe {
  return { ...recipe, ...patch, id: recipe.id, createdAt: recipe.createdAt, updatedAt: now.toISOString() };
}

/**
 * The concrete edits applying a recipe makes to the live workflow. The store
 * maps these onto the prompt/sampler/canvas capsule params.
 */
export interface RecipeApplication {
  prompt: string;
  negativePrompt: string;
  modelId: string | null;
  canvas: { width: number; height: number };
  styleTags: string[];
}

/** Resolve `{subject}` and append style tags into a final prompt string. */
export function resolveRecipePrompt(recipe: CreativeRecipe, subject: string): string {
  const template = recipe.promptTemplate.trim();
  const subj = subject.trim();
  let base: string;
  if (template.includes('{subject}')) {
    base = template.replace(/\{subject\}/g, subj || 'subject');
  } else if (template && subj) {
    base = `${subj}, ${template}`;
  } else {
    base = template || subj;
  }
  const tags = recipe.styleTags.filter((t) => t.trim()).join(', ');
  return [base.trim(), tags].filter(Boolean).join(', ');
}

/**
 * Build a workflow application from a recipe. The first aspect ratio drives the
 * canvas; callers wanting all ratios expand over recipe.aspectRatios themselves.
 */
export function applyRecipe(recipe: CreativeRecipe, subject: string): RecipeApplication {
  const aspect: AspectKey = recipe.aspectRatios[0] ?? '1:1';
  return {
    prompt: resolveRecipePrompt(recipe, subject),
    negativePrompt: recipe.negativePrompt,
    modelId: recipe.modelId || null,
    canvas: ASPECT_PRESETS[aspect],
    styleTags: recipe.styleTags,
  };
}

/** Register one use — bumps count, stamps lastUsedAt. */
export function markRecipeUsed(recipe: CreativeRecipe, now: Date): CreativeRecipe {
  return { ...recipe, timesUsed: recipe.timesUsed + 1, lastUsedAt: now.toISOString(), updatedAt: now.toISOString() };
}

const ASPECTS: AspectKey[] = ['16:9', '1:1', '9:16'];
const TARGETS = new Set(['github', 'itch', 'x', 'instagram', 'shopify', 'print', 'web']);

/** Defensive normalization for recipes loaded from persisted/imported state. */
export function sanitizeRecipe(raw: Partial<CreativeRecipe>): CreativeRecipe {
  const epoch = new Date(0).toISOString();
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const aspects = strArr(raw.aspectRatios).filter((a): a is AspectKey => ASPECTS.includes(a as AspectKey));
  const targets = strArr(raw.exportTargets).filter((t) => TARGETS.has(t));
  const score = typeof raw.successScore === 'number' ? Math.max(0, Math.min(5, raw.successScore)) : 0;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : creativeId('rec'),
    name: typeof raw.name === 'string' ? raw.name : 'Untitled Recipe',
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    styleTags: strArr(raw.styleTags),
    modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
    promptTemplate: typeof raw.promptTemplate === 'string' ? raw.promptTemplate : '',
    negativePrompt: typeof raw.negativePrompt === 'string' ? raw.negativePrompt : '',
    aspectRatios: aspects.length ? aspects : ['1:1'],
    exportTargets: targets as CreativeRecipe['exportTargets'],
    brandColors: strArr(raw.brandColors),
    successScore: score,
    timesUsed: typeof raw.timesUsed === 'number' && raw.timesUsed >= 0 ? Math.floor(raw.timesUsed) : 0,
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : epoch,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : epoch,
  };
}
