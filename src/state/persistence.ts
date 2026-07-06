import type { RackPreset, Workflow } from '../core/types';
import type { AppSettings } from './appSettings';
import type { BackendSettings } from '../turboForge/backends/backendSettings';
import type { GalleryItem } from './store';
import type { PromptToolsState } from './promptTools';

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
