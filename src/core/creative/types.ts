/**
 * Creative OS domain types — the "project brain" layer that sits ABOVE the live
 * workflow document. Everything here is pure data: brains reference gallery
 * renders / shelf models / recipes by id only (never data URLs — large media
 * must stay in IndexedDB, see the localStorage-quota note in persistence.ts).
 */

export type ProjectType = 'artwork' | 'campaign' | 'brand' | 'app' | 'exploration';

export type ProjectStatus =
  | 'spark'
  | 'in-progress'
  | 'polishing'
  | 'release-ready'
  | 'shipped'
  | 'archived';

/** Aspect-ratio slots a launch-ready project is expected to cover. */
export type AspectKey = '16:9' | '1:1' | '9:16';

/** Canvas presets per aspect slot (SD-friendly multiples of 8). */
export const ASPECT_PRESETS: Record<AspectKey, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '1:1': { width: 1024, height: 1024 },
  '9:16': { width: 720, height: 1280 },
};

export interface CoreIdentity {
  /** one-sentence "what this is" — empty string means the project has no brief yet */
  logline: string;
  audience: string;
  /** the promise/outcome the project delivers */
  promise: string;
}

export interface VisualStyle {
  styleTags: string[];
  /** brand hex colors, e.g. '#34d6f4' */
  palette: string[];
  mood: string;
}

export type AssetKind = 'logo' | 'promo' | 'reference' | 'texture' | 'font' | 'audio' | 'other';

/**
 * A tracked asset. Exactly one of `galleryId` (render in IndexedDB) or `path`
 * (external file the app cannot verify — no fs access exists) should be set.
 */
export interface LinkedAsset {
  id: string;
  label: string;
  kind: AssetKind;
  galleryId?: string;
  path?: string;
  /** 'ok' | 'broken' — broken is set by repair scans or manual marking */
  status: 'ok' | 'broken';
  archived?: boolean;
  addedAt: string;
}

export interface PromptRef {
  id: string;
  text: string;
  negative?: string;
  addedAt: string;
  /** last time this prompt was observed producing a linked render */
  lastProducedAt?: string;
}

export type ExportKind = 'release-pack' | 'zip' | 'pdf' | 'image' | 'video' | 'folder' | 'other';

/** A concrete shipped artifact — the currency of Proof Mode. */
export interface ExportRecord {
  id: string;
  kind: ExportKind;
  label: string;
  fileName: string;
  at: string;
  /** number of entries for pack/zip exports */
  itemCount?: number;
  bytes?: number;
}

export interface PublishedLink {
  id: string;
  label: string;
  url: string;
  addedAt: string;
}

export type ProjectEventType =
  | 'created'
  | 'status-changed'
  | 'identity-updated'
  | 'style-updated'
  | 'goal-added'
  | 'goal-done'
  | 'asset-linked'
  | 'asset-unlinked'
  | 'asset-repaired'
  | 'prompt-added'
  | 'render-linked'
  | 'render-unlinked'
  | 'recipe-linked'
  | 'recipe-applied'
  | 'export-built'
  | 'captions-updated'
  | 'link-published'
  | 'archived'
  | 'restored'
  | 'note';

/** One entry in a brain's replayable history (temporal replay foundation). */
export interface ProjectEvent {
  id: string;
  at: string;
  type: ProjectEventType;
  label: string;
  /** optional id of the thing the event touched (asset/render/recipe/export id) */
  ref?: string;
}

export interface StatusChange {
  at: string;
  from: ProjectStatus;
  to: ProjectStatus;
}

/** Launch copy the release pack and missing-piece detector both read. */
export interface ProjectCopy {
  shortDescription: string;
  longDescription: string;
  githubDescription: string;
  readmeSection: string;
  pressSummary: string;
  socialCaptions: string[];
}

/**
 * The project brain — persisted in the `creative` slice (and exportable as a
 * standalone `<slug>.lumendeck.project.json`). All timestamps are ISO strings.
 */
export interface ProjectBrain {
  id: string;
  schemaVersion: 1;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  identity: CoreIdentity;
  style: VisualStyle;
  activeGoals: string[];
  assets: LinkedAsset[];
  prompts: PromptRef[];
  /** gallery item ids (renders live in IndexedDB) */
  renders: string[];
  /** creative recipe ids */
  recipes: string[];
  exports: ExportRecord[];
  copy: ProjectCopy;
  publishedLinks: PublishedLink[];
  events: ProjectEvent[];
  statusHistory: StatusChange[];
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export type ExportTarget = 'github' | 'itch' | 'x' | 'instagram' | 'shopify' | 'print' | 'web';

/** A reusable creative recipe: persona + style + model + prompt scaffold. */
export interface CreativeRecipe {
  id: string;
  name: string;
  persona: string;
  styleTags: string[];
  /** shelf ModelAsset id ('' = keep whatever model is loaded) */
  modelId: string;
  /** prompt template; `{subject}` is replaced on apply when a subject is given */
  promptTemplate: string;
  negativePrompt: string;
  aspectRatios: AspectKey[];
  exportTargets: ExportTarget[];
  brandColors: string[];
  /** 0..5 user-assessed hit rate */
  successScore: number;
  timesUsed: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ---------------------------------------------------------------- analysis */

export type MissingKind =
  | 'no-identity'
  | 'no-goals'
  | 'no-logo'
  | 'no-promo-16x9'
  | 'no-promo-1x1'
  | 'no-promo-9x16'
  | 'no-short-description'
  | 'no-long-description'
  | 'no-social-captions'
  | 'no-readme-copy'
  | 'no-release-zip'
  | 'no-export-folder'
  | 'broken-asset-path'
  | 'render-missing-lineage'
  | 'prompt-without-output';

export interface MissingItem {
  kind: MissingKind;
  severity: 'blocker' | 'warn';
  label: string;
  detail: string;
  /** id of the offending asset/render/prompt when the gap is item-specific */
  ref?: string;
}

export type EntropyKind =
  | 'duplicate-render'
  | 'orphaned-render-link'
  | 'orphaned-asset'
  | 'broken-asset'
  | 'stale-prompt'
  | 'unused-render'
  | 'unlabeled-render'
  | 'project-no-exports'
  | 'campaign-missing-variants';

export type EntropyAction =
  | 'archive'
  | 'merge'
  | 'repair'
  | 'retag'
  | 'regenerate'
  | 'promote-to-recipe'
  | 'delete';

export interface EntropyItem {
  id: string;
  kind: EntropyKind;
  severity: 'high' | 'medium' | 'low';
  label: string;
  detail: string;
  /** project the item belongs to; absent for global (gallery-wide) findings */
  projectId?: string;
  /** id of the offending render/asset/prompt */
  ref?: string;
  actions: EntropyAction[];
}

export type NextActionId =
  | 'create-brief'
  | 'add-prompts'
  | 'generate-variants'
  | 'create-aspect-variants'
  | 'build-release-pack'
  | 'write-social-captions'
  | 'repair-links'
  | 'review-critique'
  | 'mark-shipped';

export interface NextAction {
  id: NextActionId;
  title: string;
  reason: string;
  /** where acting on it takes the user */
  targetView: 'mission' | 'projects' | 'recipes' | 'graph' | 'gallery' | 'entropy' | 'proof';
}

export interface CritiqueEntry {
  text: string;
  /** 0..100 sub-score backing the observation */
  score?: number;
}

/** Deterministic local project critique — no cloud calls. */
export interface CritiqueReport {
  projectId: string;
  generatedAt: string;
  /** 0..100 overall launch readiness */
  readiness: number;
  dimensions: {
    visualConsistency: number;
    assetCompleteness: number;
    promptQuality: number;
    exportReadiness: number;
    fileHygiene: number;
    launchReadiness: number;
    reusePotential: number;
  };
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  fixes: string[];
  nextAction: NextAction;
}
