# LumenDeck — Gallery Collections + IndexedDB (2026-07-06, Sub-project B)

Turn the flat, storage-starved gallery into a durable, organized workspace: move render
persistence to **IndexedDB** (fixes real data loss) and add **collections/albums, tags, and
search/filter**. Approved via brainstorming (user: collections+tags+search; storage = IndexedDB).
Deliberately NOT in scope this round: favorites/rating, A/B compare, bulk export, re-run/remix
(re-run already exists as "Restore graph"). YAGNI.

## Why IndexedDB
Today the gallery (data-URL images) persists inside the single `lumendeck.v1` localStorage blob.
`savePersisted` already hits quota and **silently drops the gallery to 12 items** — real data
loss. IndexedDB has a far larger quota, stores blobs efficiently, and is async. Moving the gallery
there removes the image payload from the localStorage blob entirely (only light metadata —
workflow, settings, promptTools — stays in localStorage).

## Storage layer — `src/state/galleryDb.ts`
A tiny dependency-free wrapper over the native IndexedDB API, database `lumendeck` (v1), two
object stores:
- `renders` (keyPath `id`) — the full `GalleryItem` plus new fields `collectionId?: string | null`
  and `tags: string[]`. Indexed on `createdAt` for ordered reads.
- `collections` (keyPath `id`) — `Collection = { id, name, createdAt }`.

All access goes through a narrow async interface so it's swappable/testable:
`GalleryStore = { allRenders(), putRender(item), deleteRender(id), allCollections(),
putCollection(c), deleteCollection(id) }`. The real impl wraps IDB; tests use an in-memory impl
of the same interface (no fake-indexeddb dependency needed — the reducer logic is where the risk
is, and it stays pure).

**Migration (one-time, lossless):** on first load after upgrade, if `renders` is empty and the
localStorage blob still carries a `gallery` array, copy those items into IndexedDB (assigning
`tags: []`, `collectionId: null`), and only after the IDB writes resolve, clear `gallery` from the
persisted localStorage state. `PersistedState.gallery` becomes optional/legacy; `savePersisted` no
longer writes images (drop the quota-exceeded slice hack for gallery). Guard everything so a
browser without IndexedDB (or a private-mode failure) falls back to the current in-memory gallery
without crashing.

## Store changes — `src/state/store.ts`
- The `gallery` slice becomes an in-memory mirror hydrated **asynchronously** from `galleryDb` at
  startup (a `galleryReady` flag; the Gallery shows a light loading state until hydrated).
- `collections: Collection[]` added, hydrated from IDB.
- Actions write through to IDB then update memory: `addGalleryItem` (already exists — now also
  persists to IDB), `removeGalleryItem`, `createCollection(name)`, `renameCollection(id,name)`,
  `deleteCollection(id)` (its renders become `collectionId: null`, never deleted),
  `assignToCollection(itemId, collectionId|null)`, `addTag(itemId, tag)`, `removeTag(itemId, tag)`.
- `enqueueRender`'s gallery insert routes through the IDB-backed `addGalleryItem`.

## Filtering — `src/core/gallery/filter.ts` (pure)
`filterGallery(items, { query, collectionId, tags }) -> GalleryItem[]`:
- `query`: case-insensitive substring over prompt, negativePrompt, and model name.
- `collectionId`: `undefined` = all; `null` = uncategorized only; a string = that collection.
- `tags`: AND-match (item must carry every selected tag).
Plus helpers `allTags(items)` (sorted unique) and `collectionCounts(items)`.

## UI — `Gallery.tsx`
- A **filter bar**: a search input; a collection selector (All / Uncategorized / each collection
  with counts) with "New collection" + rename/delete; and a tag chip row (click to toggle a tag
  filter, derived from `allTags`).
- **Card**: add a small collection/tag affordance; keep the existing open-details + download +
  remove. Show the item's tags as chips on the card meta.
- **Drawer**: add a "Collection" selector and a tag editor (add via input, remove via chip ×),
  writing through the new actions. Keep everything else (manifest, downloads, Restore graph).
- Keep the storage note but reword: renders now live in IndexedDB (durable) — export important
  ones anyway. Preserve the a11y bar (labels, roles, focus, reduced-motion, AA).

## Testing & verification
- **Pure unit (vitest)** — the core of verification: `filterGallery` (query case-insensitive;
  collectionId all/null/specific; tags AND-match; combined), `allTags`/`collectionCounts`; and a
  **store-logic suite against the in-memory `GalleryStore`**: add render → persisted; delete;
  createCollection; deleteCollection reassigns renders to null (no render lost);
  assignToCollection; addTag/removeTag dedup; and the **migration path** (localStorage gallery →
  store → cleared localStorage) driven through the in-memory impl.
- **Preview smoke** — create a collection, tag a render, filter by collection + tag + search,
  reload the page and confirm renders persist (IndexedDB), and confirm a pre-existing
  localStorage gallery migrates in on first load.
- All existing tests stay green (currently 149 vitest, 50 pytest, tsc clean). No GPU needed.

## Acceptance
1. Render several images, reload the app → all reappear (IndexedDB), none silently dropped.
2. Create "Portraits", assign two renders, filter to it → only those show; delete the collection
   → those renders survive as uncategorized.
3. Tag a render "wip", filter by "wip" → only tagged renders; search "castle" matches by prompt.
4. A user upgrading from a localStorage gallery keeps all their existing renders (migrated once).
5. localStorage no longer balloons with image data; existing capsules/flows/tests remain green.
