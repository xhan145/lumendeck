/**
 * Persisted "Field" slice for the Render-Space Ghost Controller. Owns the slice
 * SHAPE + hydration so the store stays lean and OLD persisted state (which
 * predates this feature) loads gracefully — a missing slice seeds an empty one.
 *
 * Persisted: `ghosts` (their positions/intensity/pinned) + `anchors` (saved
 * sweet spots). The transient `recording` flag on a ghost is reset to false on
 * hydrate — a reload never resumes a mid-recording session.
 *
 * See docs/superpowers/specs/2026-07-06-render-space-ghost-controller-design.md.
 */
import type { MotionParamPatch } from '../core/motion/renderPlan';
import { BUILTIN_FIELD_PRESETS, clonePreset, type FieldPreset } from '../core/field/presets';

/** A translucent controller orb flown through the render-space field. */
export interface Ghost {
  id: string;
  nodeId: string;
  /** Normalized field position; each axis in [0,1]. */
  pos: { x: number; y: number; z: number };
  /** [0,1] displacement scale from each bundle midpoint (a ghost-local control). */
  intensity: number;
  /** Pinned ghosts stay put on collapse-all / cleanup passes. */
  pinned: boolean;
  /** TRANSIENT: true only while actively recording a path (never persisted live). */
  recording: boolean;
}

/** A saved sweet spot: the ghost position + the exact param values there. */
export interface Anchor {
  id: string;
  nodeId: string;
  name: string;
  pos: { x: number; y: number; z: number };
  values: MotionParamPatch[];
}

/**
 * Field slice: live ghosts + saved anchors, PLUS the field-preset + streaming-
 * preview state (v0.19). Only `ghosts`, `anchors`, `presets` and `activePresetId`
 * persist; `previewImage`/`previewPending`/`streamingEnabled` are TRANSIENT (never
 * written — a reload never resurrects a preview image or auto-streams the GPU).
 */
export interface FieldState {
  ghosts: Ghost[];
  anchors: Anchor[];
  /** Field presets: the 10 builtins (seeded) + user custom presets. */
  presets: FieldPreset[];
  /** Active preset id (null = v0.16 auto-derived field; unchanged behavior). */
  activePresetId: string | null;
  /** TRANSIENT: the latest low-res streaming-preview image (never persisted). */
  previewImage: string | null;
  /** TRANSIENT: a preview render is in flight (never persisted). */
  previewPending: boolean;
  /** TRANSIENT per-session: drag-to-preview streaming on/off (off by default). */
  streamingEnabled: boolean;
}

/**
 * The persisted PROJECTION of the field slice — additive over the v0.16 blob:
 * ghosts + anchors, plus `presets` (custom + edited/visible builtins) and the
 * `hiddenBuiltinIds` (builtins the user deleted, so they stay hidden on reload)
 * and `activePresetId`. Transient preview fields are deliberately absent. Every
 * field is optional so OLD blobs (which predate presets) still load.
 */
export interface PersistedFieldState {
  ghosts?: Ghost[];
  anchors?: Anchor[];
  presets?: FieldPreset[];
  hiddenBuiltinIds?: string[];
  activePresetId?: string | null;
}

/** A brand-new field state: empty ghosts/anchors, the 10 builtins seeded. */
export function defaultFieldState(): FieldState {
  return {
    ghosts: [],
    anchors: [],
    presets: BUILTIN_FIELD_PRESETS.map(clonePreset),
    activePresetId: null,
    previewImage: null,
    previewPending: false,
    streamingEnabled: false,
  };
}

/** Lenient runtime shape check for a persisted preset (drops junk on load). */
function isValidPreset(raw: unknown): raw is FieldPreset {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<FieldPreset>;
  if (typeof p.id !== 'string' || typeof p.name !== 'string' || !p.axes || typeof p.axes !== 'object') return false;
  const axes = p.axes as FieldPreset['axes'];
  for (const key of ['x', 'y', 'z'] as const) {
    const b = axes[key];
    if (!b || !Array.isArray(b.params) || typeof b.label !== 'string') return false;
  }
  return true;
}

/**
 * Rebuild the runtime presets list from the persisted list + hidden ids: keep the
 * (valid) persisted presets, then re-add any builtin that is NOT already present
 * AND was NOT explicitly hidden — so genuinely-new builtins shipped after the save
 * appear, deleted builtins stay hidden, and edited builtins keep their edits.
 * Mirrors hydratePromptTools.
 */
function hydratePresets(persisted: FieldPreset[] | undefined, hidden: string[] | undefined): FieldPreset[] {
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden.filter((h) => typeof h === 'string') : []);
  const list = Array.isArray(persisted) ? persisted.filter(isValidPreset).map(clonePreset) : [];
  const present = new Set(list.map((p) => p.id));
  for (const b of BUILTIN_FIELD_PRESETS) {
    if (!present.has(b.id) && !hiddenSet.has(b.id)) list.push(clonePreset(b));
  }
  return list;
}

function toPos(raw: unknown): { x: number; y: number; z: number } {
  const p = (raw ?? {}) as Partial<{ x: number; y: number; z: number }>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { x: n(p.x), y: n(p.y), z: n(p.z) };
}

function hydrateGhost(raw: unknown): Ghost | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<Ghost>;
  if (typeof g.id !== 'string' || typeof g.nodeId !== 'string') return null;
  return {
    id: g.id,
    nodeId: g.nodeId,
    pos: toPos(g.pos),
    intensity: typeof g.intensity === 'number' && Number.isFinite(g.intensity) ? g.intensity : 1,
    pinned: g.pinned === true,
    // Never resume a recording across a reload — always start settled.
    recording: false,
  };
}

function hydrateAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<Anchor>;
  if (typeof a.id !== 'string' || typeof a.nodeId !== 'string') return null;
  const values = Array.isArray(a.values)
    ? a.values.filter(
        (v): v is MotionParamPatch =>
          !!v && typeof v === 'object' &&
          typeof (v as MotionParamPatch).nodeId === 'string' &&
          typeof (v as MotionParamPatch).param === 'string' &&
          typeof (v as MotionParamPatch).value === 'number',
      )
    : [];
  return {
    id: a.id,
    nodeId: a.nodeId,
    name: typeof a.name === 'string' ? a.name : 'Anchor',
    pos: toPos(a.pos),
    values,
  };
}

/**
 * Additive hydration: a missing/invalid slice -> default (seeded) state; a present
 * slice is sanitized (drops malformed ghosts/anchors, resets the transient
 * recording flag, seeds/merges presets) so old blobs and partially-written state
 * always load without crashing. Preview fields always start clean (a reload never
 * resurrects a preview image, a pending render, or an armed streaming toggle).
 */
export function hydrateField(persisted: PersistedFieldState | undefined): FieldState {
  if (!persisted || typeof persisted !== 'object') return defaultFieldState();
  const ghosts = Array.isArray(persisted.ghosts)
    ? persisted.ghosts.map(hydrateGhost).filter((g): g is Ghost => g !== null)
    : [];
  const anchors = Array.isArray(persisted.anchors)
    ? persisted.anchors.map(hydrateAnchor).filter((a): a is Anchor => a !== null)
    : [];
  const presets = hydratePresets(persisted.presets, persisted.hiddenBuiltinIds);
  // Only keep an active id that still resolves to a live preset.
  const activePresetId =
    typeof persisted.activePresetId === 'string' && presets.some((p) => p.id === persisted.activePresetId)
      ? persisted.activePresetId
      : null;
  return {
    ghosts,
    anchors,
    presets,
    activePresetId,
    previewImage: null,
    previewPending: false,
    streamingEnabled: false,
  };
}
