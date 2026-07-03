import type { RackPreset, Workflow } from '../core/types';
import type { BackendSettings } from '../turboForge/backends/backendSettings';
import type { GalleryItem } from './store';

const KEY = 'lumendeck.v1';

export interface PersistedState {
  workflow: Workflow;
  rackPresets: RackPreset[];
  gallery: GalleryItem[];
  backendSettings: BackendSettings;
}

export function loadPersisted(): Partial<PersistedState> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Partial<PersistedState>;
    if (data.workflow && data.workflow.schemaVersion !== 1) {
      console.warn('LumenDeck: unknown workflow schema, starting fresh.');
      return {};
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
