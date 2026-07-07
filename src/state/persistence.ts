import type { RackPreset, Workflow } from '../core/types';
import type { AppSettings } from './appSettings';
import type { BackendSettings } from '../turboForge/backends/backendSettings';
import type { GalleryItem } from './store';
import type { PromptToolsState } from './promptTools';
import type { MotionState } from '../core/motion/types';
import type { FieldState } from './field';
import type { AudioState } from './audio';
import type { AudioMapping } from '../core/audio/mapping';

const KEY = 'lumendeck.v1';

export interface PersistedState {
  workflow: Workflow;
  rackPresets: RackPreset[];
  /**
   * LEGACY gallery blob. Renders now live in IndexedDB (see galleryDb.ts).
   * This field is only ever READ once on startup for the one-time migration and
   * is never written again — savePersisted no longer serializes render images
   * (they ballooned the blob and hit quota). Optional so new saves omit it.
   */
  gallery?: GalleryItem[];
  backendSettings: BackendSettings;
  appSettings?: AppSettings;
  /**
   * Prompt & Creative Tooling slice (presets / wildcards / history). Optional so
   * state saved before this feature still loads: a missing slice falls back to the
   * seeded defaults in the store (additive, backward-compatible migration).
   */
  promptTools?: PromptToolsState;
  /**
   * Motion Engine slice: authored clips + active clip id. Optional so state saved
   * before this feature still loads — a missing slice is seeded with an empty
   * state plus the demo clip (see hydrateMotion). Only the persisted `clips`/
   * `activeClipId` live here; the ephemeral transport playhead is NEVER persisted.
   */
  motion?: MotionState;
  /**
   * Render-Space Ghost Controller slice: ghosts + anchors. Optional so state saved
   * before this feature still loads — a missing slice hydrates to an empty one
   * (see hydrateField). The transient per-ghost `recording` flag is never resumed
   * across a reload (it is reset on hydrate).
   */
  field?: FieldState;
  /**
   * Audio Reactivity slice — ONLY the editable `mapping` + `sensitivity`.
   * Optional so state saved before this feature still loads (missing -> the
   * workflow's default mapping via hydrateAudio). The live `running`/`source`
   * are NEVER persisted, so a reload never auto-listens to the microphone.
   */
  audio?: { mapping?: AudioMapping; sensitivity?: number };
}

/**
 * The subset of the store that gets persisted. Deliberately EXCLUDES the
 * ephemeral transport (playhead) so that transport writes during playback never
 * change the projection — the persistence subscription bails on an unchanged
 * projection, so playback can no longer starve the trailing-debounce save
 * (BUG 2a). Pure + structural so it is unit-testable without the store.
 */
export function persistedProjection(state: {
  workflow: Workflow;
  rackPresets: RackPreset[];
  backendSettings: BackendSettings;
  appSettings: AppSettings;
  promptTools: PromptToolsState;
  motion: MotionState;
  /** Optional so callers assembled before this slice existed still typecheck. */
  field?: FieldState;
  /** Optional so callers assembled before this slice existed still typecheck. */
  audio?: AudioState;
}): PersistedState {
  return {
    workflow: state.workflow,
    rackPresets: state.rackPresets,
    // gallery is intentionally omitted — renders live in IndexedDB now.
    backendSettings: state.backendSettings,
    appSettings: state.appSettings,
    promptTools: state.promptTools,
    // Persist authored clips only; the ephemeral transport playhead is dropped.
    motion: state.motion,
    // Persist ghosts + anchors, but STRIP the transient per-ghost `recording`
    // flag so toggling Record on/off never churns persistence (and a reload never
    // resumes a mid-recording session — hydrateField also resets it defensively).
    field: state.field
      ? {
          ghosts: state.field.ghosts.map(({ recording: _recording, ...g }) => ({ ...g, recording: false })),
          anchors: state.field.anchors,
        }
      : { ghosts: [], anchors: [] },
    // Persist ONLY the mapping + sensitivity; the live running/source are dropped
    // so a reload never resumes listening (mic privacy) and toggling Start/Stop
    // never churns persistence.
    audio: state.audio ? { mapping: state.audio.mapping, sensitivity: state.audio.sensitivity } : undefined,
  };
}

export function loadPersisted(): Partial<PersistedState> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Partial<PersistedState>;
    // Drop a persisted workflow that is the wrong version OR structurally invalid,
    // so stale/old saved state can never crash startup (blank page).
    if (data.workflow) {
      const wf = data.workflow as Partial<Workflow>;
      const valid = wf.schemaVersion === 1 && Array.isArray(wf.nodes) && Array.isArray(wf.edges);
      if (!valid) {
        console.warn('LumenDeck: incompatible saved workflow, starting fresh.');
        delete (data as Partial<PersistedState>).workflow;
      }
    }
    return data;
  } catch (err) {
    console.warn('LumenDeck: failed to load saved state, starting fresh.', err);
    return {};
  }
}

export function savePersisted(state: PersistedState): void {
  if (typeof localStorage === 'undefined') return;
  // Never serialize render images here anymore — the gallery lives in IndexedDB.
  // Only light metadata (workflow, presets, settings, promptTools) is persisted,
  // so the old quota-slice hack is gone.
  const { gallery: _legacy, ...light } = state;
  try {
    localStorage.setItem(KEY, JSON.stringify(light));
  } catch (err) {
    console.warn('LumenDeck: could not persist state.', err);
  }
}

/**
 * Read the legacy localStorage gallery (for the one-time IDB migration) and then
 * strip it from the persisted blob so it is never read again. Safe to call when
 * nothing is stored.
 */
export function takeLegacyGallery(): GalleryItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as Partial<PersistedState>;
    const gallery = Array.isArray(data.gallery) ? data.gallery : [];
    return gallery;
  } catch {
    return [];
  }
}

/** Remove only the legacy `gallery` field from the persisted blob, in place. */
export function clearLegacyGallery(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Partial<PersistedState> & { gallery?: unknown };
    if (data.gallery === undefined) return;
    delete data.gallery;
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (err) {
    console.warn('LumenDeck: could not clear legacy gallery blob.', err);
  }
}
