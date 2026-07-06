import type { RackPreset, Workflow } from '../core/types';
import type { AppSettings } from './appSettings';
import type { BackendSettings } from '../turboForge/backends/backendSettings';
import type { GalleryItem } from './store';

const KEY = 'lumendeck.v1';

export interface PersistedState {
  workflow: Workflow;
  rackPresets: RackPreset[];
  gallery: GalleryItem[];
  backendSettings: BackendSettings;
  appSettings?: AppSettings;
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
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    // Quota exceeded (gallery images are data URLs) — drop oldest gallery items and retry once.
    try {
      const slim = { ...state, gallery: state.gallery.slice(0, 12) };
      localStorage.setItem(KEY, JSON.stringify(slim));
    } catch {
      console.warn('LumenDeck: could not persist state.', err);
    }
  }
}
