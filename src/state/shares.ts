/**
 * Published share-links slice: a local record of every hosted Showcase the user has
 * published, so they can be listed and unpublished. Follows the house slice pattern
 * (type + defaultX + hydrateX with additive, defensive migration). Pure list edits so
 * the store thunks stay terse and this is unit-testable without the store.
 *
 * The `token` is the opaque HMAC delete-capability returned by publish-showcase; the
 * app only carries it (never computes it). See src/bridge/publish.ts + the
 * unpublish-showcase Edge Function.
 */

export interface PublishedShare {
  id: string;
  title: string;
  url: string;
  path: string;
  token: string;
  kind: 'gallery' | 'project';
  sourceId?: string;
  publishedAt: number;
}

export function defaultShares(): PublishedShare[] {
  return [];
}

function isValid(v: unknown): v is PublishedShare {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.url === 'string' &&
    typeof s.path === 'string' &&
    typeof s.token === 'string' &&
    (s.kind === 'gallery' || s.kind === 'project') &&
    typeof s.publishedAt === 'number'
  );
}

export function hydrateShares(persisted: unknown): PublishedShare[] {
  if (!Array.isArray(persisted)) return [];
  return persisted.filter(isValid).map((s) => ({
    id: s.id,
    title: typeof s.title === 'string' ? s.title : 'Untitled',
    url: s.url,
    path: s.path,
    token: s.token,
    kind: s.kind,
    sourceId: typeof s.sourceId === 'string' ? s.sourceId : undefined,
    publishedAt: s.publishedAt,
  }));
}

export function addShare(
  list: PublishedShare[],
  input: Omit<PublishedShare, 'id' | 'publishedAt'>,
  id: string,
  now: number,
): PublishedShare[] {
  return [{ ...input, id, publishedAt: now }, ...list];
}

export function removeShare(list: PublishedShare[], id: string): PublishedShare[] {
  return list.filter((s) => s.id !== id);
}
