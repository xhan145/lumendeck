/**
 * Pure gallery filtering + derived helpers. No React, no store, no IDB — this is
 * the core of the verification bar (see tests/galleryCollections.test.ts).
 */
import type { GalleryItem } from '../../state/store';

export interface GalleryFilter {
  /** Case-insensitive substring over prompt / negativePrompt / model name. */
  query?: string;
  /**
   * `undefined` = all items; `null` = uncategorized only (no collectionId);
   * a string = only items assigned to that collection.
   */
  collectionId?: string | null;
  /** AND-match: an item must carry EVERY selected tag. */
  tags?: string[];
}

function matchesQuery(item: GalleryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const m = item.manifest;
  const haystack = [m?.prompt ?? '', m?.negativePrompt ?? '', m?.model?.name ?? '']
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesCollection(item: GalleryItem, collectionId: string | null | undefined): boolean {
  if (collectionId === undefined) return true; // all
  if (collectionId === null) return item.collectionId == null; // uncategorized
  return item.collectionId === collectionId;
}

function matchesTags(item: GalleryItem, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return true;
  const owned = new Set((item.tags ?? []).map((t) => t.toLowerCase()));
  return tags.every((t) => owned.has(t.toLowerCase()));
}

export function filterGallery(items: GalleryItem[], filter: GalleryFilter = {}): GalleryItem[] {
  const { query = '', collectionId, tags } = filter;
  return items.filter(
    (item) =>
      matchesQuery(item, query) &&
      matchesCollection(item, collectionId) &&
      matchesTags(item, tags),
  );
}

/** Sorted, de-duplicated list of every tag used across the gallery. */
export function allTags(items: GalleryItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      const trimmed = tag.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface CollectionCounts {
  /** total items regardless of collection */
  all: number;
  /** items with no collection assigned */
  uncategorized: number;
  /** per-collectionId counts */
  byId: Record<string, number>;
}

export function collectionCounts(items: GalleryItem[]): CollectionCounts {
  const byId: Record<string, number> = {};
  let uncategorized = 0;
  for (const item of items) {
    if (item.collectionId == null) {
      uncategorized += 1;
    } else {
      byId[item.collectionId] = (byId[item.collectionId] ?? 0) + 1;
    }
  }
  return { all: items.length, uncategorized, byId };
}
