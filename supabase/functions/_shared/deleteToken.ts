// Shared, runtime-agnostic delete-token logic for hosted share-links.
//
// Uses ONLY Web Crypto + TextEncoder + base64url, so this exact file runs unchanged
// in Deno (imported by the publish-showcase / unpublish-showcase Edge Functions via
// `../_shared/deleteToken.ts`) AND in Node/vitest (imported by tests/deleteToken.test.ts
// as `../supabase/functions/_shared/deleteToken`). One source of truth for the HMAC —
// there is no mirrored copy to keep in sync.

/** base64url (no padding) of raw bytes. */
function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Capability token authorizing deletion of `path`:
 * token = base64url(HMAC-SHA256(secret, path)). Unguessable without `secret`.
 */
export async function deleteToken(secret: string, path: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(path));
  return base64url(new Uint8Array(sig));
}

/**
 * Storage object keys we allow deleting: `<slug>-<uuid>.html` — all lowercase alnum +
 * hyphens ending in `.html` (the exact shape publish-showcase mints). Rejects traversal
 * (`..`, `/`) and any non-html key, so a valid token can only ever remove a real showcase.
 */
export function isValidObjectPath(path: string): boolean {
  return typeof path === 'string' && /^[a-z0-9][a-z0-9-]*\.html$/.test(path);
}

/** Length-safe, constant-time string compare (no early exit on first differing char). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type UnpublishAuth = { ok: true } | { ok: false; status: number; error: string };

/**
 * Pure authorization decision for an unpublish request. `ok` only when the path is a
 * valid object key AND the supplied token matches HMAC(secret, path). The HTTP handler
 * performs the storage delete only on `{ ok: true }`.
 */
export async function authorizeUnpublish(secret: string, path: unknown, token: unknown): Promise<UnpublishAuth> {
  if (typeof path !== 'string' || !isValidObjectPath(path)) return { ok: false, status: 400, error: 'Invalid or missing path' };
  if (typeof token !== 'string' || token.length === 0) return { ok: false, status: 400, error: 'Missing token' };
  const expected = await deleteToken(secret, path);
  if (!constantTimeEqual(token, expected)) return { ok: false, status: 403, error: 'Ownership could not be verified for this link' };
  return { ok: true };
}
