/**
 * Project brain lifecycle: create / update / event recording / (de)serialization.
 * Pure module — callers pass `now` so every mutation is deterministic in tests
 * (same convention as buildManifest).
 */
import type {
  CreativeRecipe,
  ProjectBrain,
  ProjectEvent,
  ProjectEventType,
  ProjectStatus,
  ProjectType,
} from './types';
import { sanitizeRecipe } from './recipes';

let seq = 0;
/** Unique-per-session id; random tail keeps ids distinct across reloads. */
export function creativeId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Events per brain are ring-buffered: the brain lives in the localStorage
 * projection, so unbounded histories would eventually crowd the quota that
 * already evicted the legacy gallery blob.
 */
export const MAX_EVENTS = 200;

export function createBrain(name: string, type: ProjectType, now: Date): ProjectBrain {
  const at = now.toISOString();
  return {
    id: creativeId('proj'),
    schemaVersion: 1,
    name: name.trim() || 'Untitled Project',
    type,
    status: 'spark',
    identity: { logline: '', audience: '', promise: '' },
    style: { styleTags: [], palette: [], mood: '' },
    activeGoals: [],
    assets: [],
    prompts: [],
    renders: [],
    recipes: [],
    exports: [],
    copy: {
      shortDescription: '',
      longDescription: '',
      githubDescription: '',
      readmeSection: '',
      pressSummary: '',
      socialCaptions: [],
    },
    publishedLinks: [],
    events: [{ id: creativeId('ev'), at, type: 'created', label: `Project "${name.trim() || 'Untitled Project'}" created` }],
    statusHistory: [],
    createdAt: at,
    updatedAt: at,
    lastOpenedAt: at,
  };
}

/** Append an event (ring-buffered) and bump updatedAt. Returns a new brain. */
export function recordEvent(
  brain: ProjectBrain,
  type: ProjectEventType,
  label: string,
  now: Date,
  ref?: string,
): ProjectBrain {
  const ev: ProjectEvent = { id: creativeId('ev'), at: now.toISOString(), type, label, ...(ref ? { ref } : {}) };
  const events = [...brain.events, ev].slice(-MAX_EVENTS);
  return { ...brain, events, updatedAt: now.toISOString() };
}

/**
 * Apply a partial update to a brain, bumping updatedAt and logging one event.
 * Status changes additionally append to statusHistory so replay can show the
 * full lifecycle even after the event ring buffer rotates.
 */
export function updateBrain(
  brain: ProjectBrain,
  patch: Partial<Omit<ProjectBrain, 'id' | 'schemaVersion' | 'createdAt' | 'events' | 'statusHistory'>>,
  now: Date,
  event?: { type: ProjectEventType; label: string; ref?: string },
): ProjectBrain {
  let next: ProjectBrain = { ...brain, ...patch, updatedAt: now.toISOString() };
  if (patch.status && patch.status !== brain.status) {
    next = {
      ...next,
      statusHistory: [...brain.statusHistory, { at: now.toISOString(), from: brain.status, to: patch.status }],
    };
    next = recordEvent(next, 'status-changed', `Status: ${brain.status} → ${patch.status}`, now);
  }
  if (event) next = recordEvent(next, event.type, event.label, now, event.ref);
  return next;
}

export function touchOpened(brain: ProjectBrain, now: Date): ProjectBrain {
  // Deliberately does NOT bump updatedAt — opening is not an edit.
  return { ...brain, lastOpenedAt: now.toISOString() };
}

/* ------------------------------------------------------- project.json file */

/** Portable single-project file: `<slug>.lumendeck.project.json`. */
export interface ProjectFile {
  schemaVersion: 1;
  app: 'LumenDeck';
  kind: 'project-brain';
  savedAt: string;
  brain: ProjectBrain;
  /** recipes the brain references, embedded so the file is self-contained */
  recipes: CreativeRecipe[];
}

export function buildProjectFile(brain: ProjectBrain, recipes: CreativeRecipe[], now: Date): ProjectFile {
  const referenced = recipes.filter((r) => brain.recipes.includes(r.id));
  return { schemaVersion: 1, app: 'LumenDeck', kind: 'project-brain', savedAt: now.toISOString(), brain, recipes: referenced };
}

export type ParseProjectResult =
  | { ok: true; file: ProjectFile }
  | { ok: false; error: string };

/** Never-throwing parse, mirroring parseLumenFile's tagged-result contract. */
export function parseProjectFile(text: string): ParseProjectResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'Not a project file.' };
  const file = data as Partial<ProjectFile>;
  if (file.kind !== 'project-brain' || file.schemaVersion !== 1) {
    return { ok: false, error: 'Not a LumenDeck project file (or unsupported version).' };
  }
  const brain = file.brain as Partial<ProjectBrain> | undefined;
  if (!brain || typeof brain.id !== 'string' || typeof brain.name !== 'string' || !Array.isArray(brain.events)) {
    return { ok: false, error: 'Project brain data is malformed.' };
  }
  return {
    ok: true,
    file: {
      schemaVersion: 1,
      app: 'LumenDeck',
      kind: 'project-brain',
      savedAt: typeof file.savedAt === 'string' ? file.savedAt : new Date(0).toISOString(),
      brain: sanitizeBrain(brain),
      // Deep-sanitize imported recipes (drop non-objects) so a malformed/old recipe
      // can never crash the Recipes view or applyCreativeRecipe — mirrors hydrateCreative.
      recipes: Array.isArray(file.recipes)
        ? file.recipes.filter((r) => typeof r === 'object' && r !== null).map((r) => sanitizeRecipe(r as Partial<CreativeRecipe>))
        : [],
    },
  };
}

const PROJECT_TYPES: ProjectType[] = ['artwork', 'campaign', 'brand', 'app', 'exploration'];
const PROJECT_STATUSES: ProjectStatus[] = ['spark', 'in-progress', 'polishing', 'release-ready', 'shipped', 'archived'];

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
/** Keep only string members of an array (drops non-strings that would crash `.slice`/`.trim` later). */
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Keep only object members, mapped through `f`; drops nulls/primitives that would crash downstream. */
const objArr = <T,>(v: unknown, f: (o: Record<string, unknown>) => T): T[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null).map(f) : [];

/**
 * Defensive per-field normalization so a hand-edited or pre-release brain can
 * never crash startup (same philosophy as hydrateField/sanitizeAppSettings).
 * Nested arrays are DEEP-sanitized: a prompt without `text`, a non-string render
 * id, or a malformed asset can never reach the engines that dereference them.
 */
export function sanitizeBrain(raw: Partial<ProjectBrain>): ProjectBrain {
  const epoch = new Date(0).toISOString();
  const type = PROJECT_TYPES.includes(raw.type as ProjectType) ? (raw.type as ProjectType) : 'exploration';
  const status = PROJECT_STATUSES.includes(raw.status as ProjectStatus) ? (raw.status as ProjectStatus) : 'spark';
  const copy = (raw.copy ?? {}) as Partial<ProjectBrain['copy']>;
  const identity = (raw.identity ?? {}) as Partial<ProjectBrain['identity']>;
  const style = (raw.style ?? {}) as Partial<ProjectBrain['style']>;
  const ASSET_KINDS = ['logo', 'promo', 'reference', 'texture', 'font', 'audio', 'other'];
  return {
    id: str(raw.id) || creativeId('proj'),
    schemaVersion: 1,
    name: str(raw.name, 'Untitled Project'),
    type,
    status,
    identity: { logline: str(identity.logline), audience: str(identity.audience), promise: str(identity.promise) },
    style: { styleTags: strArr(style.styleTags), palette: strArr(style.palette), mood: str(style.mood) },
    activeGoals: strArr(raw.activeGoals),
    assets: objArr(raw.assets, (a) => ({
      id: str(a.id) || creativeId('as'),
      label: str(a.label, 'Untitled asset'),
      kind: (ASSET_KINDS.includes(a.kind as string) ? a.kind : 'other') as ProjectBrain['assets'][number]['kind'],
      galleryId: typeof a.galleryId === 'string' ? a.galleryId : undefined,
      path: typeof a.path === 'string' ? a.path : undefined,
      status: a.status === 'broken' ? 'broken' : 'ok',
      archived: a.archived === true ? true : undefined,
      addedAt: str(a.addedAt, epoch),
    })),
    prompts: objArr(raw.prompts, (p) => ({
      id: str(p.id) || creativeId('pr'),
      text: str(p.text),
      negative: typeof p.negative === 'string' ? p.negative : undefined,
      addedAt: str(p.addedAt, epoch),
      lastProducedAt: typeof p.lastProducedAt === 'string' ? p.lastProducedAt : undefined,
    })),
    renders: strArr(raw.renders),
    recipes: strArr(raw.recipes),
    exports: objArr(raw.exports, (e) => ({
      id: str(e.id) || creativeId('exp'),
      kind: (['release-pack', 'zip', 'pdf', 'image', 'video', 'folder', 'other'].includes(e.kind as string) ? e.kind : 'other') as ProjectBrain['exports'][number]['kind'],
      label: str(e.label, 'Export'),
      fileName: str(e.fileName, 'export'),
      at: str(e.at, epoch),
      itemCount: typeof e.itemCount === 'number' ? e.itemCount : undefined,
      bytes: typeof e.bytes === 'number' ? e.bytes : undefined,
    })),
    copy: {
      shortDescription: str(copy.shortDescription),
      longDescription: str(copy.longDescription),
      githubDescription: str(copy.githubDescription),
      readmeSection: str(copy.readmeSection),
      pressSummary: str(copy.pressSummary),
      socialCaptions: strArr(copy.socialCaptions),
    },
    publishedLinks: objArr(raw.publishedLinks, (l) => ({
      id: str(l.id) || creativeId('ln'),
      label: str(l.label, 'Link'),
      url: str(l.url),
      addedAt: str(l.addedAt, epoch),
    })),
    events: objArr(raw.events, (e) => ({
      id: str(e.id) || creativeId('ev'),
      at: str(e.at, epoch),
      type: str(e.type, 'note') as ProjectBrain['events'][number]['type'],
      label: str(e.label),
      ref: typeof e.ref === 'string' ? e.ref : undefined,
    })),
    statusHistory: objArr(raw.statusHistory, (s) => ({
      at: str(s.at, epoch),
      from: str(s.from, 'spark') as ProjectStatus,
      to: str(s.to, 'spark') as ProjectStatus,
    })),
    createdAt: str(raw.createdAt, epoch),
    updatedAt: str(raw.updatedAt, epoch),
    lastOpenedAt: str(raw.lastOpenedAt, epoch),
  };
}
