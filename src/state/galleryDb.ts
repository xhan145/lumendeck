/**
 * Durable gallery storage over the native IndexedDB API — dependency-free.
 *
 * Renders (data-URL images/videos + manifest) used to live inside the single
 * `lumendeck.v1` localStorage blob, which hit quota and SILENTLY dropped items.
 * They now live in IndexedDB (large quota, async) behind a narrow interface so
 * the store logic stays swappable/testable:
 *
 *   - `createIdbGalleryStore()` — the real IDB-backed impl (browser/Tauri webview).
 *   - `createMemoryGalleryStore()` — an in-memory impl of the SAME interface used
 *     by tests AND as the runtime fallback when IndexedDB is unavailable (private
 *     mode / disabled) so the gallery degrades gracefully instead of crashing.
 *
 * Database `lumendeck` (v1), two object stores:
 *   - `renders` (keyPath `id`) with a `createdAt` index for ordered reads.
 *   - `collections` (keyPath `id`).
 */
import type { GalleryItem } from './store';

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
}

/** Narrow async contract every gallery backend implements. */
export interface GalleryStore {
  allRenders(): Promise<GalleryItem[]>;
  putRender(item: GalleryItem): Promise<void>;
  deleteRender(id: string): Promise<void>;
  allCollections(): Promise<Collection[]>;
  putCollection(c: Collection): Promise<void>;
  deleteCollection(id: string): Promise<void>;
}

const DB_NAME = 'lumendeck';
const DB_VERSION = 1;
const RENDERS = 'renders';
const COLLECTIONS = 'collections';

/** True when a usable IndexedDB implementation is present on this platform. */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // Some privacy modes throw merely on property access.
    return false;
  }
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RENDERS)) {
        const store = db.createObjectStore(RENDERS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(COLLECTIONS)) {
        db.createObjectStore(COLLECTIONS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

/**
 * Real IndexedDB-backed store. Each call opens/uses a shared connection; on any
 * failure the promise rejects so the caller can fall back to the in-memory store.
 */
export function createIdbGalleryStore(): GalleryStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());

  async function tx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result: T;
      run(store)
        .then((value) => {
          result = value;
        })
        .catch(reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  return {
    async allRenders() {
      const items = await tx<GalleryItem[]>(RENDERS, 'readonly', (store) =>
        promisifyRequest(store.getAll() as IDBRequest<GalleryItem[]>),
      );
      // Newest first, matching the previous in-memory ordering.
      return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },
    async putRender(item) {
      await tx(RENDERS, 'readwrite', (store) => promisifyRequest(store.put(item)));
    },
    async deleteRender(id) {
      await tx(RENDERS, 'readwrite', (store) => promisifyRequest(store.delete(id)));
    },
    async allCollections() {
      const items = await tx<Collection[]>(COLLECTIONS, 'readonly', (store) =>
        promisifyRequest(store.getAll() as IDBRequest<Collection[]>),
      );
      return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    async putCollection(c) {
      await tx(COLLECTIONS, 'readwrite', (store) => promisifyRequest(store.put(c)));
    },
    async deleteCollection(id) {
      await tx(COLLECTIONS, 'readwrite', (store) => promisifyRequest(store.delete(id)));
    },
  };
}

/** In-memory impl of the same interface — used by tests and as a runtime fallback. */
export function createMemoryGalleryStore(seed?: {
  renders?: GalleryItem[];
  collections?: Collection[];
}): GalleryStore {
  const renders = new Map<string, GalleryItem>();
  const collections = new Map<string, Collection>();
  for (const r of seed?.renders ?? []) renders.set(r.id, { ...r });
  for (const c of seed?.collections ?? []) collections.set(c.id, { ...c });

  return {
    async allRenders() {
      return [...renders.values()]
        .map((r) => ({ ...r }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },
    async putRender(item) {
      renders.set(item.id, { ...item });
    },
    async deleteRender(id) {
      renders.delete(id);
    },
    async allCollections() {
      return [...collections.values()]
        .map((c) => ({ ...c }))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    async putCollection(c) {
      collections.set(c.id, { ...c });
    },
    async deleteCollection(id) {
      collections.delete(id);
    },
  };
}

/**
 * Return the best available gallery store: the real IDB one when IndexedDB is
 * present, otherwise an in-memory fallback so private-mode/unsupported browsers
 * never crash (they just lose durability, matching the pre-IDB behavior).
 */
export function resolveGalleryStore(): { store: GalleryStore; durable: boolean } {
  if (idbAvailable()) {
    try {
      return { store: createIdbGalleryStore(), durable: true };
    } catch {
      /* fall through to memory */
    }
  }
  return { store: createMemoryGalleryStore(), durable: false };
}
