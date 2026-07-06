/**
 * Write-through gallery/collection operations. Each helper persists to the async
 * `GalleryStore` FIRST, then returns the next in-memory arrays for the caller
 * (the Zustand store) to swap in. Keeping this logic pure + store-agnostic makes
 * the risky reducer behavior (esp. collection deletion + migration) unit-testable
 * against `createMemoryGalleryStore` without React or a real IndexedDB.
 */
import type { GalleryItem } from '../../state/store';
import type { Collection, GalleryStore } from '../../state/galleryDb';

let seq = 0;
/** Small id helper (mirrors store's uid but dependency-free for testability). */
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Persist a new render and prepend it to the in-memory gallery (newest first). */
export async function addRender(
  store: GalleryStore,
  gallery: GalleryItem[],
  item: GalleryItem,
): Promise<GalleryItem[]> {
  const normalized: GalleryItem = {
    ...item,
    collectionId: item.collectionId ?? null,
    tags: uniqueTags(item.tags ?? []),
  };
  await store.putRender(normalized);
  return [normalized, ...gallery.filter((g) => g.id !== normalized.id)];
}

export async function removeRender(
  store: GalleryStore,
  gallery: GalleryItem[],
  id: string,
): Promise<GalleryItem[]> {
  await store.deleteRender(id);
  return gallery.filter((g) => g.id !== id);
}

export async function createCollection(
  store: GalleryStore,
  collections: Collection[],
  name: string,
): Promise<{ collections: Collection[]; created: Collection }> {
  const created: Collection = { id: newId('col'), name: name.trim() || 'Untitled', createdAt: new Date().toISOString() };
  await store.putCollection(created);
  return { collections: [...collections, created], created };
}

export async function renameCollection(
  store: GalleryStore,
  collections: Collection[],
  id: string,
  name: string,
): Promise<Collection[]> {
  const existing = collections.find((c) => c.id === id);
  if (!existing) return collections;
  const updated: Collection = { ...existing, name: name.trim() || existing.name };
  await store.putCollection(updated);
  return collections.map((c) => (c.id === id ? updated : c));
}

/**
 * Delete a collection. Its renders are RE-ASSIGNED to `collectionId: null`
 * (uncategorized) and re-persisted — renders are NEVER deleted. Returns the next
 * collections + gallery arrays.
 */
export async function deleteCollection(
  store: GalleryStore,
  collections: Collection[],
  gallery: GalleryItem[],
  id: string,
): Promise<{ collections: Collection[]; gallery: GalleryItem[] }> {
  // Re-home affected renders first so no render is ever orphaned/lost.
  const affected = gallery.filter((g) => g.collectionId === id);
  const nextGallery = gallery.map((g) => (g.collectionId === id ? { ...g, collectionId: null } : g));
  for (const g of affected) {
    await store.putRender({ ...g, collectionId: null });
  }
  await store.deleteCollection(id);
  return { collections: collections.filter((c) => c.id !== id), gallery: nextGallery };
}

export async function assignToCollection(
  store: GalleryStore,
  gallery: GalleryItem[],
  itemId: string,
  collectionId: string | null,
): Promise<GalleryItem[]> {
  const existing = gallery.find((g) => g.id === itemId);
  if (!existing) return gallery;
  const updated: GalleryItem = { ...existing, collectionId };
  await store.putRender(updated);
  return gallery.map((g) => (g.id === itemId ? updated : g));
}

export async function addTag(
  store: GalleryStore,
  gallery: GalleryItem[],
  itemId: string,
  tag: string,
): Promise<GalleryItem[]> {
  const existing = gallery.find((g) => g.id === itemId);
  if (!existing) return gallery;
  const updated: GalleryItem = { ...existing, tags: uniqueTags([...(existing.tags ?? []), tag]) };
  await store.putRender(updated);
  return gallery.map((g) => (g.id === itemId ? updated : g));
}

export async function removeTag(
  store: GalleryStore,
  gallery: GalleryItem[],
  itemId: string,
  tag: string,
): Promise<GalleryItem[]> {
  const existing = gallery.find((g) => g.id === itemId);
  if (!existing) return gallery;
  const key = tag.toLowerCase();
  const updated: GalleryItem = { ...existing, tags: (existing.tags ?? []).filter((t) => t.toLowerCase() !== key) };
  await store.putRender(updated);
  return gallery.map((g) => (g.id === itemId ? updated : g));
}

export interface MigrationResult {
  migrated: number;
  /** true when items were copied into IDB (localStorage gallery should now be cleared). */
  didMigrate: boolean;
}

/**
 * One-time, LOSSLESS migration from the legacy localStorage gallery into the
 * durable store. Copies each legacy item (assigning `tags: []`, `collectionId:
 * null` when absent) ONLY when the store's `renders` is currently empty and the
 * legacy array is non-empty. The caller must clear the localStorage `gallery`
 * ONLY after this resolves successfully (all IDB writes committed).
 */
export async function migrateLegacyGallery(
  store: GalleryStore,
  legacy: GalleryItem[] | undefined,
): Promise<MigrationResult> {
  const legacyItems = Array.isArray(legacy) ? legacy : [];
  if (legacyItems.length === 0) return { migrated: 0, didMigrate: false };

  const existing = await store.allRenders();
  if (existing.length > 0) return { migrated: 0, didMigrate: false };

  for (const item of legacyItems) {
    await store.putRender({
      ...item,
      collectionId: item.collectionId ?? null,
      tags: Array.isArray(item.tags) ? item.tags : [],
    });
  }
  return { migrated: legacyItems.length, didMigrate: true };
}
