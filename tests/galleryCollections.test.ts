import { describe, expect, it } from 'vitest';
import type { GalleryItem } from '../src/state/store';
import type { ExportManifest } from '../src/core/manifest';
import { allTags, collectionCounts, filterGallery } from '../src/core/gallery/filter';
import {
  createMemoryGalleryStore,
  type Collection,
} from '../src/state/galleryDb';
import {
  addRender,
  removeRender,
  createCollection,
  renameCollection,
  deleteCollection,
  assignToCollection,
  addTag,
  removeTag,
  migrateLegacyGallery,
} from '../src/core/gallery/ops';

// ---------------------------------------------------------------------------
// helpers: minimal GalleryItem fixtures (only the fields the code reads)
// ---------------------------------------------------------------------------
function mkManifest(over: Partial<ExportManifest> = {}): ExportManifest {
  return {
    app: 'LumenDeck',
    appVersion: '0.0.0',
    createdAt: '2026-07-06T00:00:00Z',
    prompt: 'a prompt',
    negativePrompt: '',
    resolvedPrompt: 'a prompt',
    wildcards: [],
    seed: 1,
    sampler: { name: 'euler', steps: 20, cfg: 7 },
    canvas: { width: 512, height: 512 },
    media: { type: 'image', format: 'png', frameCount: 1, fps: 0 },
    model: null,
    loras: [],
    controlNets: [],
    graphVersion: 1,
    graph: { schemaVersion: 1, version: 1, nodes: [], edges: [] } as unknown as ExportManifest['graph'],
    ...over,
  };
}

let seq = 0;
type MkOver = Partial<Omit<GalleryItem, 'manifest'>> & { manifest?: Partial<ExportManifest> };
function mk(over: MkOver = {}): GalleryItem {
  seq += 1;
  const { manifest, ...rest } = over;
  return {
    dataUrl: 'data:image/png;base64,AAA',
    ...rest,
    id: rest.id ?? `r${seq}`,
    createdAt: rest.createdAt ?? `2026-07-06T00:00:0${seq % 10}Z`,
    manifest: mkManifest(manifest),
    collectionId: rest.collectionId ?? null,
    tags: rest.tags ?? [],
  };
}

// ===========================================================================
// filterGallery (pure)
// ===========================================================================
describe('filterGallery', () => {
  const items = [
    mk({ id: 'a', manifest: { prompt: 'A CASTLE on a hill', negativePrompt: 'blurry' } }),
    mk({ id: 'b', manifest: { prompt: 'a portrait', model: { id: 'm1', name: 'DreamCastle XL', family: 'sdxl', hash: 'h' } } }),
    mk({ id: 'c', manifest: { prompt: 'a robot', negativePrompt: 'lowres CASTLE artifact' } }),
    mk({ id: 'd', manifest: { prompt: 'nothing relevant' } }),
  ];

  it('query is case-insensitive across prompt, negativePrompt, and model name', () => {
    const ids = filterGallery(items, { query: 'castle' }).map((i) => i.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('empty query returns everything', () => {
    expect(filterGallery(items, { query: '' })).toHaveLength(4);
    expect(filterGallery(items, {})).toHaveLength(4);
  });

  it('collectionId undefined = all, null = uncategorized, string = that collection', () => {
    const set = [
      mk({ id: '1', collectionId: 'col-x' }),
      mk({ id: '2', collectionId: 'col-x' }),
      mk({ id: '3', collectionId: null }),
      mk({ id: '4', collectionId: undefined }),
    ];
    expect(filterGallery(set, { collectionId: undefined }).map((i) => i.id).sort()).toEqual(['1', '2', '3', '4']);
    expect(filterGallery(set, { collectionId: null }).map((i) => i.id).sort()).toEqual(['3', '4']);
    expect(filterGallery(set, { collectionId: 'col-x' }).map((i) => i.id).sort()).toEqual(['1', '2']);
  });

  it('tags AND-match (item must carry every selected tag), case-insensitive', () => {
    const set = [
      mk({ id: '1', tags: ['wip', 'hero'] }),
      mk({ id: '2', tags: ['wip'] }),
      mk({ id: '3', tags: ['Hero'] }),
      mk({ id: '4', tags: ['wip', 'HERO', 'extra'] }),
    ];
    expect(filterGallery(set, { tags: ['wip'] }).map((i) => i.id).sort()).toEqual(['1', '2', '4']);
    expect(filterGallery(set, { tags: ['wip', 'hero'] }).map((i) => i.id).sort()).toEqual(['1', '4']);
    expect(filterGallery(set, { tags: [] }).map((i) => i.id).sort()).toEqual(['1', '2', '3', '4']);
  });

  it('combines query + collection + tags', () => {
    const set = [
      mk({ id: '1', collectionId: 'c1', tags: ['wip'], manifest: { prompt: 'a castle' } }),
      mk({ id: '2', collectionId: 'c1', tags: ['wip'], manifest: { prompt: 'a robot' } }),
      mk({ id: '3', collectionId: 'c2', tags: ['wip'], manifest: { prompt: 'a castle' } }),
      mk({ id: '4', collectionId: 'c1', tags: ['done'], manifest: { prompt: 'a castle' } }),
    ];
    expect(filterGallery(set, { query: 'castle', collectionId: 'c1', tags: ['wip'] }).map((i) => i.id)).toEqual(['1']);
  });
});

// ===========================================================================
// allTags + collectionCounts
// ===========================================================================
describe('allTags', () => {
  it('returns sorted unique tags across the gallery', () => {
    const set = [
      mk({ tags: ['zebra', 'apple'] }),
      mk({ tags: ['apple', 'mango'] }),
      mk({ tags: [] }),
      mk({ tags: ['  '] }),
    ];
    expect(allTags(set)).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('collectionCounts', () => {
  it('counts all, uncategorized, and per-collection', () => {
    const set = [
      mk({ collectionId: 'x' }),
      mk({ collectionId: 'x' }),
      mk({ collectionId: 'y' }),
      mk({ collectionId: null }),
      mk({ collectionId: undefined }),
    ];
    const counts = collectionCounts(set);
    expect(counts.all).toBe(5);
    expect(counts.uncategorized).toBe(2);
    expect(counts.byId).toEqual({ x: 2, y: 1 });
  });
});

// ===========================================================================
// store-logic write-through against the in-memory GalleryStore
// ===========================================================================
describe('gallery write-through ops (in-memory store)', () => {
  it('addRender persists to the store and prepends to memory', async () => {
    const store = createMemoryGalleryStore();
    const item = mk({ id: 'x' });
    const gallery = await addRender(store, [], item);
    expect(gallery.map((g) => g.id)).toEqual(['x']);
    const persisted = await store.allRenders();
    expect(persisted.map((g) => g.id)).toEqual(['x']);
    // normalized defaults are applied
    expect(persisted[0].collectionId).toBeNull();
    expect(persisted[0].tags).toEqual([]);
  });

  it('removeRender deletes from store and memory', async () => {
    const store = createMemoryGalleryStore({ renders: [mk({ id: 'a' }), mk({ id: 'b' })] });
    const gallery = await removeRender(store, await store.allRenders(), 'a');
    expect(gallery.map((g) => g.id).sort()).toEqual(['b']);
    expect((await store.allRenders()).map((g) => g.id)).toEqual(['b']);
  });

  it('createCollection persists a new collection', async () => {
    const store = createMemoryGalleryStore();
    const { collections, created } = await createCollection(store, [], 'Portraits');
    expect(collections).toHaveLength(1);
    expect(created.name).toBe('Portraits');
    expect((await store.allCollections()).map((c) => c.name)).toEqual(['Portraits']);
  });

  it('renameCollection updates name in store and memory', async () => {
    const store = createMemoryGalleryStore();
    const { collections } = await createCollection(store, [], 'Old');
    const id = collections[0].id;
    const next = await renameCollection(store, collections, id, 'New');
    expect(next.find((c) => c.id === id)?.name).toBe('New');
    expect((await store.allCollections())[0].name).toBe('New');
  });

  it('deleteCollection reassigns its renders to null — ZERO renders lost', async () => {
    const col: Collection = { id: 'col-1', name: 'Set', createdAt: '2026-07-06T00:00:00Z' };
    const renders = [
      mk({ id: 'r1', collectionId: 'col-1' }),
      mk({ id: 'r2', collectionId: 'col-1' }),
      mk({ id: 'r3', collectionId: null }),
    ];
    const store = createMemoryGalleryStore({ renders, collections: [col] });
    const { collections, gallery } = await deleteCollection(
      store,
      await store.allCollections(),
      await store.allRenders(),
      'col-1',
    );
    expect(collections).toHaveLength(0);
    // Same number of renders — none deleted.
    expect(gallery).toHaveLength(3);
    const persisted = await store.allRenders();
    expect(persisted).toHaveLength(3);
    // The formerly-assigned renders are now uncategorized.
    expect(persisted.find((r) => r.id === 'r1')?.collectionId).toBeNull();
    expect(persisted.find((r) => r.id === 'r2')?.collectionId).toBeNull();
    // The collection itself is gone.
    expect((await store.allCollections())).toHaveLength(0);
  });

  it('assignToCollection moves a render between collections and to null', async () => {
    const store = createMemoryGalleryStore({ renders: [mk({ id: 'r1', collectionId: null })] });
    let gallery = await store.allRenders();
    gallery = await assignToCollection(store, gallery, 'r1', 'col-9');
    expect((await store.allRenders()).find((r) => r.id === 'r1')?.collectionId).toBe('col-9');
    gallery = await assignToCollection(store, gallery, 'r1', null);
    expect((await store.allRenders()).find((r) => r.id === 'r1')?.collectionId).toBeNull();
  });

  it('addTag dedups (case-insensitive) and removeTag removes', async () => {
    const store = createMemoryGalleryStore({ renders: [mk({ id: 'r1', tags: [] })] });
    let gallery = await store.allRenders();
    gallery = await addTag(store, gallery, 'r1', 'Wip');
    gallery = await addTag(store, gallery, 'r1', 'wip'); // dup, ignored
    gallery = await addTag(store, gallery, 'r1', 'hero');
    expect((await store.allRenders()).find((r) => r.id === 'r1')?.tags).toEqual(['Wip', 'hero']);
    gallery = await removeTag(store, gallery, 'r1', 'WIP'); // case-insensitive remove
    expect((await store.allRenders()).find((r) => r.id === 'r1')?.tags).toEqual(['hero']);
  });
});

// ===========================================================================
// migration path (legacy localStorage gallery -> IDB, then clear)
// ===========================================================================
describe('migrateLegacyGallery (lossless one-time)', () => {
  it('copies every legacy item into the store when it is empty', async () => {
    const store = createMemoryGalleryStore();
    const legacy = [
      mk({ id: 'g1', manifest: { prompt: 'one' } }),
      mk({ id: 'g2', manifest: { prompt: 'two' } }),
      mk({ id: 'g3', manifest: { prompt: 'three' } }),
    ];
    // Simulate legacy items without the new fields at all.
    for (const g of legacy) { delete (g as Partial<GalleryItem>).tags; delete (g as Partial<GalleryItem>).collectionId; }

    const result = await migrateLegacyGallery(store, legacy);
    expect(result.didMigrate).toBe(true);
    expect(result.migrated).toBe(3);

    const persisted = await store.allRenders();
    expect(persisted).toHaveLength(3);
    expect(persisted.map((r) => r.id).sort()).toEqual(['g1', 'g2', 'g3']);
    // New fields assigned during migration.
    for (const r of persisted) {
      expect(r.collectionId).toBeNull();
      expect(r.tags).toEqual([]);
    }
  });

  it('does NOT migrate when the store already has renders (idempotent)', async () => {
    const store = createMemoryGalleryStore({ renders: [mk({ id: 'existing' })] });
    const result = await migrateLegacyGallery(store, [mk({ id: 'legacy' })]);
    expect(result.didMigrate).toBe(false);
    expect(result.migrated).toBe(0);
    expect((await store.allRenders()).map((r) => r.id)).toEqual(['existing']);
  });

  it('is a no-op for an empty/absent legacy gallery', async () => {
    const store = createMemoryGalleryStore();
    expect((await migrateLegacyGallery(store, [])).didMigrate).toBe(false);
    expect((await migrateLegacyGallery(store, undefined)).didMigrate).toBe(false);
    expect(await store.allRenders()).toHaveLength(0);
  });

  it('end-to-end: legacy blob -> migrate -> caller clears localStorage; none lost', async () => {
    // Simulate the store's hydrate flow with an in-memory "localStorage".
    const fakeLocal: { gallery?: GalleryItem[] } = {
      gallery: [mk({ id: 'a' }), mk({ id: 'b' }), mk({ id: 'c' })],
    };
    const store = createMemoryGalleryStore();

    const legacy = fakeLocal.gallery;
    const result = await migrateLegacyGallery(store, legacy);
    // Only AFTER migration resolves do we clear the legacy blob (mirrors store).
    if (result.didMigrate) delete fakeLocal.gallery;

    expect(result.didMigrate).toBe(true);
    expect(fakeLocal.gallery).toBeUndefined(); // localStorage gallery cleared
    const persisted = await store.allRenders();
    expect(persisted).toHaveLength(3); // none lost
    expect(persisted.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
