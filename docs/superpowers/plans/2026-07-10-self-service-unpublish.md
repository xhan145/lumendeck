# Self-service Unpublish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a creator take down any hosted share-link they published, from one central place in the app, authorized by a per-link secret token.

**Architecture:** Publishing already uploads a self-contained Showcase HTML through the `publish-showcase` Edge Function (the only write path into the public bucket). We add a stateless HMAC capability token: publish returns `{ url, path, token }`; a new `unpublish-showcase` Edge Function recomputes `HMAC(secret, path)`, constant-time compares the supplied token, and deletes the object on match. The app persists every published link in a new `shares` state slice and surfaces them in a "Published links" card in Studio Overview with Copy / Open / Unpublish.

**Tech Stack:** TypeScript, React 18, Zustand, Vite 6, Vitest; Supabase Edge Functions (Deno) + Storage; Web Crypto (HMAC-SHA256) shared across Deno and Node.

## Global Constraints

- **Version target:** bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and `Cargo.lock`) to **0.25.0** in lockstep — `tests/versionSync.test.ts` asserts parity with `APP_VERSION`.
- **Local-first / privacy:** the app never holds the server secret; it only carries the opaque `token` returned at publish. The Supabase **service key** must live only in the Edge Function env, never in the app. The `SUPABASE_ANON_KEY` in `src/bridge/publish.ts` is public by design.
- **Single source of truth for the token algorithm:** `supabase/functions/_shared/deleteToken.ts` — imported by both Edge Functions (Deno, `.ts` extension) AND by `tests/deleteToken.test.ts` (Node, no extension). No mirrored copy.
- **Additive persistence:** the new `shares` slice is optional in `PersistedState`; pre-0.25 saved state must still load (missing slice → empty list).
- **No silent success/failure:** `publishShowcase` throws if `path`/`token` are absent; `unpublishShare` never drops a local row unless the server confirms deletion (or the user explicitly forgets it).
- **No public MSI release** until the user explicitly says "release".
- **Zustand rule:** never call a getter inside a selector (`useStudio((s) => s.foo())`); subscribe to slices and derive with `useMemo`.

---

### Task 1: Shared delete-token helper

**Files:**
- Create: `supabase/functions/_shared/deleteToken.ts`
- Test: `tests/deleteToken.test.ts`

**Interfaces:**
- Produces:
  - `deleteToken(secret: string, path: string): Promise<string>` — base64url(HMAC-SHA256(secret, path)).
  - `isValidObjectPath(path: string): boolean` — `^[a-z0-9][a-z0-9-]*\.html$`.
  - `constantTimeEqual(a: string, b: string): boolean`.
  - `authorizeUnpublish(secret: string, path: unknown, token: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/deleteToken.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  deleteToken,
  isValidObjectPath,
  constantTimeEqual,
  authorizeUnpublish,
} from '../supabase/functions/_shared/deleteToken';

describe('deleteToken', () => {
  it('is deterministic base64url for the same secret+path', async () => {
    const a = await deleteToken('s3cr3t', 'neon-cat-abc.html');
    const b = await deleteToken('s3cr3t', 'neon-cat-abc.html');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no '=' padding
  });
  it('differs across paths and across secrets', async () => {
    expect(await deleteToken('s', 'a.html')).not.toBe(await deleteToken('s', 'b.html'));
    expect(await deleteToken('s1', 'a.html')).not.toBe(await deleteToken('s2', 'a.html'));
  });
});

describe('isValidObjectPath', () => {
  it('accepts real publish paths', () => {
    expect(isValidObjectPath('neon-cat-550e8400-e29b-41d4-a716-446655440000.html')).toBe(true);
    expect(isValidObjectPath('showcase-abc.html')).toBe(true);
  });
  it('rejects traversal, slashes, uppercase, and non-html keys', () => {
    for (const p of ['../secret.html', 'a/b.html', 'file.png', 'UPPER.html', '.html', 'no-ext', 'a.html/x', '']) {
      expect(isValidObjectPath(p)).toBe(false);
    }
  });
});

describe('constantTimeEqual', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });
});

describe('authorizeUnpublish', () => {
  const secret = 'test-secret';
  it('ok for a matching token', async () => {
    const path = 'neon-cat-abc.html';
    const token = await deleteToken(secret, path);
    expect(await authorizeUnpublish(secret, path, token)).toEqual({ ok: true });
  });
  it('403 for a wrong token', async () => {
    const r = await authorizeUnpublish(secret, 'neon-cat-abc.html', 'wrong');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.error).toMatch(/ownership/i); }
  });
  it('400 for a bad path even with a "valid" token for that path', async () => {
    const bad = '../evil.html';
    const r = await authorizeUnpublish(secret, bad, await deleteToken(secret, bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
  it('400 for a missing token', async () => {
    const r = await authorizeUnpublish(secret, 'a.html', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/deleteToken.test.ts`
Expected: FAIL — cannot resolve `../supabase/functions/_shared/deleteToken`.

- [ ] **Step 3: Write minimal implementation**

Create `supabase/functions/_shared/deleteToken.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/deleteToken.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/deleteToken.ts tests/deleteToken.test.ts
git commit -m "feat(unpublish): shared HMAC delete-token helper + tests"
```

---

### Task 2: `unpublish-showcase` Edge Function

**Files:**
- Create: `supabase/functions/unpublish-showcase/index.ts`

**Interfaces:**
- Consumes: `authorizeUnpublish` from `../_shared/deleteToken.ts`; env `LUMENDECK_DELETE_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Produces: HTTP `POST { path, token }` → `200 { ok: true }` on success, `400` bad path/token, `403` ownership mismatch, `500` config/storage error.

> This is Deno code deployed to Supabase; it is not exercised by vitest (the algorithm it calls is covered by Task 1). Verification is the real deploy + e2e in Task 8.

- [ ] **Step 1: Write the function**

Create `supabase/functions/unpublish-showcase/index.ts`:

```ts
// Supabase Edge Function: unpublish-showcase
//
// The delete counterpart to publish-showcase. Takes { path, token }, recomputes the
// stateless HMAC capability token (see _shared/deleteToken.ts), constant-time compares,
// and — only on match — removes the object from the public `lumendeck-showcases` bucket
// with the SERVICE key. Idempotent: an already-absent object still returns { ok: true }.
// No rate-limit: the token is a 256-bit secret with no guessing oracle.
//
// Deploy: `supabase functions deploy unpublish-showcase`
// Requires project secret LUMENDECK_DELETE_SECRET (same value publish-showcase signs with).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { authorizeUnpublish } from '../_shared/deleteToken.ts';

const BUCKET = 'lumendeck-showcases';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { path?: unknown; token?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const secret = Deno.env.get('LUMENDECK_DELETE_SECRET');
  if (!secret) return json({ error: 'Server not configured for unpublish' }, 500);

  const auth = await authorizeUnpublish(secret, body?.path, body?.token);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const path = body.path as string; // validated by authorizeUnpublish
  const { error: rmErr } = await admin.storage.from(BUCKET).remove([path]);
  // remove() is idempotent — a missing object is not an error. Only surface real failures.
  if (rmErr) return json({ error: `Delete failed: ${rmErr.message}` }, 500);

  return json({ ok: true }, 200);
});
```

- [ ] **Step 2: Typecheck the repo (function is not in tsc's include, but the shared helper is)**

Run: `npm run typecheck`
Expected: PASS — no errors introduced. (The function file is Deno-only and outside `tsconfig.include`; only `_shared/deleteToken.ts` is pulled in via the test import and must typecheck, which Task 1 already ensured.)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/unpublish-showcase/index.ts
git commit -m "feat(unpublish): unpublish-showcase Edge Function (HMAC-verified delete)"
```

---

### Task 3: `publish-showcase` returns `{ url, path, token }`

**Files:**
- Modify: `supabase/functions/publish-showcase/index.ts`

**Interfaces:**
- Consumes: `deleteToken` from `../_shared/deleteToken.ts`; env `LUMENDECK_DELETE_SECRET`.
- Produces: publish response body gains `path` and `token` (additive — existing `.url`-only readers unaffected).

- [ ] **Step 1: Add the import**

At the top of `supabase/functions/publish-showcase/index.ts`, after the existing `import { createClient } ...` line, add:

```ts
import { deleteToken } from '../_shared/deleteToken.ts';
```

- [ ] **Step 2: Compute the token and return it**

Replace the final success return (currently):

```ts
  await admin.from('lumendeck_publish_events').insert({ ip });

  return json({ url: `${url}/storage/v1/object/public/${BUCKET}/${path}` }, 200);
```

with:

```ts
  await admin.from('lumendeck_publish_events').insert({ ip });

  // Stateless HMAC capability token so the publisher — and only the publisher — can
  // later unpublish this exact object (see unpublish-showcase + _shared/deleteToken.ts).
  const secret = Deno.env.get('LUMENDECK_DELETE_SECRET');
  const token = secret ? await deleteToken(secret, path) : '';
  return json({ url: `${url}/storage/v1/object/public/${BUCKET}/${path}`, path, token }, 200);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (function file not typechecked by tsc; the shared helper already passes).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/publish-showcase/index.ts
git commit -m "feat(unpublish): publish-showcase returns { path, token } for later unpublish"
```

---

### Task 4: Client bridge — `path`/`token` on publish + `unpublishShowcase`

**Files:**
- Modify: `src/bridge/publish.ts`
- Test: `tests/publish.test.ts`

**Interfaces:**
- Consumes: `PUBLISH_ENDPOINT`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (existing).
- Produces:
  - `PublishResult { url: string; path: string; token: string }`.
  - `UNPUBLISH_ENDPOINT: string`.
  - `UnpublishResult { ok: boolean; status: number; error?: string }`.
  - `unpublishShowcase(path: string, token: string, opts?: PublishOptions): Promise<UnpublishResult>` — never throws on an HTTP error (403 is an expected outcome); returns `{ ok:false, status:0 }` on a network throw.

- [ ] **Step 1: Write the failing tests (extend `tests/publish.test.ts`)**

Add these imports to the top of `tests/publish.test.ts`:

```ts
import { publishShowcase, isPublishConfigured, PUBLISH_ENDPOINT, PUBLISH_MAX_BYTES, unpublishShowcase, UNPUBLISH_ENDPOINT } from '../src/bridge/publish';
```

(replace the existing import line from `../src/bridge/publish`.)

Update the first `publishShowcase` test to assert the new fields, and change the mock body to include them:

```ts
  it('POSTs {html,slug} to the Edge Function with the anon bearer and returns url+path+token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://x.supabase.co/storage/v1/object/public/lumendeck-showcases/neon-cat-UUID.html', path: 'neon-cat-UUID.html', token: 'tok123' }), { status: 200 }),
    );
    const res = await publishShowcase('<!doctype html><h1>hi</h1>', 'neon-cat', { fetchImpl: fetchMock });
    expect(res.url).toContain('/object/public/lumendeck-showcases/neon-cat-');
    expect(res.path).toBe('neon-cat-UUID.html');
    expect(res.token).toBe('tok123');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(PUBLISH_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ html: '<!doctype html><h1>hi</h1>', slug: 'neon-cat' });
  });
```

The "defaults an empty slug" test's mock body must also carry `path`/`token` so it does not throw:

```ts
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://x/y.html', path: 'y.html', token: 't' }), { status: 200 }));
```

Add a new test that publish throws when the server omits `path`/`token`:

```ts
  it('throws when the response omits path or token (no half-recorded share)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://x/y.html' }), { status: 200 }));
    await expect(publishShowcase('<html></html>', 'p', { fetchImpl: fetchMock })).rejects.toThrow(/path.*token|token.*path|did not include/i);
  });
```

Add an `unpublishShowcase` describe block:

```ts
describe('unpublishShowcase', () => {
  it('POSTs {path,token} to the unpublish endpoint and returns ok on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await unpublishShowcase('neon-cat-UUID.html', 'tok123', { fetchImpl: fetchMock });
    expect(r).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(UNPUBLISH_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(String(init.body))).toEqual({ path: 'neon-cat-UUID.html', token: 'tok123' });
  });
  it('returns ok:false with the status + server error on a non-OK response (does not throw)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Ownership could not be verified for this link' }), { status: 403 }));
    const r = await unpublishShowcase('a.html', 'bad', { fetchImpl: fetchMock });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/ownership/i);
  });
  it('returns ok:false status:0 when fetch itself throws (offline)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await unpublishShowcase('a.html', 't', { fetchImpl: fetchMock });
    expect(r).toEqual({ ok: false, status: 0, error: 'network down' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/publish.test.ts`
Expected: FAIL — `unpublishShowcase`/`UNPUBLISH_ENDPOINT` not exported; `PublishResult` lacks `path`/`token`.

- [ ] **Step 3: Implement in `src/bridge/publish.ts`**

Change `PublishResult`:

```ts
export interface PublishResult {
  url: string;
  path: string;
  token: string;
}
```

Add the endpoint constant next to `PUBLISH_ENDPOINT`:

```ts
export const UNPUBLISH_ENDPOINT = `${SUPABASE_URL}/functions/v1/unpublish-showcase`;
```

Update the tail of `publishShowcase` (the `if (!data?.url) ...; return ...`) to:

```ts
  const data = (await res.json().catch(() => null)) as { url?: string; path?: string; token?: string; error?: string } | null;
  if (!res.ok) {
    throw new Error(`Publish failed (${res.status}): ${data?.error ?? res.statusText}`);
  }
  if (!data?.url) throw new Error('Publish response did not include a URL.');
  if (!data.path || !data.token) throw new Error('Publish response did not include a path/token (server not upgraded for unpublish).');
  return { url: data.url, path: data.path, token: data.token };
```

Append the new function + result type at the end of the file:

```ts
export interface UnpublishResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Remove a previously published showcase. POSTs { path, token } to the unpublish Edge
 * Function, which HMAC-verifies ownership and deletes the object. Does NOT throw on an
 * HTTP error — a 403 (ownership mismatch) is an expected outcome the caller branches on;
 * a network failure returns { ok:false, status:0, error }.
 */
export async function unpublishShowcase(path: string, token: string, opts: PublishOptions = {}): Promise<UnpublishResult> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(UNPUBLISH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, token }),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
  if (res.ok) return { ok: true, status: res.status };
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, status: res.status, error: data?.error ?? res.statusText };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/publish.test.ts`
Expected: PASS (all publish + unpublish cases).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/publish.ts tests/publish.test.ts
git commit -m "feat(unpublish): publish returns path/token; add unpublishShowcase client"
```

---

### Task 5: `shares` state slice

**Files:**
- Create: `src/state/shares.ts`
- Test: `tests/shares.test.ts`

**Interfaces:**
- Produces:
  - `interface PublishedShare { id: string; title: string; url: string; path: string; token: string; kind: 'gallery' | 'project'; sourceId?: string; publishedAt: number }`.
  - `defaultShares(): PublishedShare[]` → `[]`.
  - `hydrateShares(persisted: unknown): PublishedShare[]` — keeps only well-formed entries (string `url`/`path`/`token`, valid `kind`).
  - `addShare(list, input, id, now): PublishedShare[]` — pure prepend; `input` is `Omit<PublishedShare,'id'|'publishedAt'>`.
  - `removeShare(list, id): PublishedShare[]` — pure filter.

- [ ] **Step 1: Write the failing test**

Create `tests/shares.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultShares, hydrateShares, addShare, removeShare, type PublishedShare } from '../src/state/shares';

const sample: PublishedShare = { id: 'a', title: 'Neon cat', url: 'https://x/neon.html', path: 'neon.html', token: 't', kind: 'gallery', sourceId: 'g1', publishedAt: 100 };

describe('shares slice', () => {
  it('defaultShares is empty', () => {
    expect(defaultShares()).toEqual([]);
  });

  it('hydrateShares keeps well-formed entries and drops malformed ones', () => {
    const persisted = [
      sample,
      { id: 'b', title: 'no token', url: 'https://x/b.html', path: 'b.html', kind: 'project', publishedAt: 1 }, // missing token
      { id: 'c', title: 'bad kind', url: 'https://x/c.html', path: 'c.html', token: 't', kind: 'nope', publishedAt: 1 }, // bad kind
      'garbage',
      null,
    ];
    const out = hydrateShares(persisted);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('hydrateShares tolerates non-arrays', () => {
    expect(hydrateShares(undefined)).toEqual([]);
    expect(hydrateShares({})).toEqual([]);
  });

  it('addShare prepends a new share with the given id + timestamp', () => {
    const list = addShare([sample], { title: 'Two', url: 'https://x/2.html', path: '2.html', token: 't2', kind: 'project', sourceId: 'p1' }, 'id2', 200);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'id2', title: 'Two', publishedAt: 200, kind: 'project' });
    expect(list[1].id).toBe('a');
  });

  it('removeShare drops by id and is a no-op for unknown ids', () => {
    expect(removeShare([sample], 'a')).toEqual([]);
    expect(removeShare([sample], 'zzz')).toEqual([sample]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shares.test.ts`
Expected: FAIL — cannot resolve `../src/state/shares`.

- [ ] **Step 3: Write the implementation**

Create `src/state/shares.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shares.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/shares.ts tests/shares.test.ts
git commit -m "feat(unpublish): published-shares state slice (pure + tested)"
```

---

### Task 6: Wire the slice into the store + persistence

**Files:**
- Modify: `src/state/store.ts`
- Modify: `src/state/persistence.ts`
- Test: `tests/shares.test.ts` (append store + projection integration), `tests/store.test.ts` is untouched.

**Interfaces:**
- Consumes: `hydrateShares`, `addShare`, `removeShare`, `PublishedShare` (Task 5); `unpublishShowcase`, `UnpublishResult` (Task 4).
- Produces on `StudioState`:
  - `publishedShares: PublishedShare[]`.
  - `recordPublishedShare(input: Omit<PublishedShare, 'id' | 'publishedAt'>): void`.
  - `removePublishedShare(id: string): void` (local-only "forget").
  - `unpublishShare(id: string): Promise<UnpublishResult>` — calls the server; removes the row only on `ok`.
- Produces on `PersistedState`: `shares?: PublishedShare[]`; projection emits `shares`.

- [ ] **Step 1: Write the failing integration test (append to `tests/shares.test.ts`)**

Append:

```ts
import { persistedProjection } from '../src/state/persistence';
import { useStudio } from '../src/state/store';

describe('shares — store + persistence integration', () => {
  it('recordPublishedShare adds a row; removePublishedShare drops it', () => {
    const store = useStudio.getState();
    const before = store.publishedShares.length;
    store.recordPublishedShare({ title: 'Rec', url: 'https://x/r.html', path: 'r.html', token: 'tk', kind: 'gallery', sourceId: 'g9' });
    const added = useStudio.getState().publishedShares;
    expect(added.length).toBe(before + 1);
    expect(added[0]).toMatchObject({ title: 'Rec', path: 'r.html', kind: 'gallery' });
    expect(typeof added[0].id).toBe('string');
    expect(added[0].id.length).toBeGreaterThan(0);

    useStudio.getState().removePublishedShare(added[0].id);
    expect(useStudio.getState().publishedShares.find((s) => s.id === added[0].id)).toBeUndefined();
  });

  it('persistedProjection round-trips publishedShares under `shares`', () => {
    const proj = persistedProjection({
      // minimal shape — only publishedShares matters here; the projection reads the rest
      // straight through from the live store state passed by the subscription.
      ...useStudio.getState(),
      publishedShares: [{ id: 'p1', title: 'T', url: 'https://x/p.html', path: 'p.html', token: 'k', kind: 'project', publishedAt: 5 }],
    } as Parameters<typeof persistedProjection>[0]);
    expect(proj.shares).toEqual([{ id: 'p1', title: 'T', url: 'https://x/p.html', path: 'p.html', token: 'k', kind: 'project', publishedAt: 5 }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/shares.test.ts`
Expected: FAIL — `recordPublishedShare` is not a function / `proj.shares` undefined.

- [ ] **Step 3: Persistence — add `shares` to `PersistedState` and the projection**

In `src/state/persistence.ts`:

Add the import near the other slice imports:

```ts
import type { PublishedShare } from './shares';
```

Add the field to `PersistedState` (after the `nodeMeta?` field):

```ts
  /**
   * Published hosted share-links (url + storage path + HMAC delete token). Optional so
   * state saved before this feature still loads (missing -> empty via hydrateShares).
   */
  shares?: PublishedShare[];
```

Add to the `persistedProjection` input type (after `nodeMeta?`):

```ts
  /** Optional so callers assembled before this slice existed still typecheck. */
  publishedShares?: PublishedShare[];
```

Add to the returned projection object (after `creative: state.creative,`):

```ts
    // Published share-links — light metadata (no render bytes), safe to persist.
    shares: state.publishedShares ?? [],
```

- [ ] **Step 4: Store — type, initial state, actions, subscription**

In `src/state/store.ts`:

Add imports (near the `hydrateCreative` import and the publish import — publish is imported in components today, so add a fresh import here):

```ts
import { hydrateShares, addShare, removeShare, type PublishedShare } from './shares';
import { unpublishShowcase, type UnpublishResult } from '../bridge/publish';
```

Add to the `StudioState` interface, at the end of the Creative OS slice section (after `seedCreativeDemo(): void;`):

```ts
  /* -------------------------------------------------- Published share-links */
  publishedShares: PublishedShare[];
  recordPublishedShare(input: Omit<PublishedShare, 'id' | 'publishedAt'>): void;
  /** Local-only removal ("Forget locally") — does not call the server. */
  removePublishedShare(id: string): void;
  /** Server-side unpublish; removes the local row only when the server confirms. */
  unpublishShare(id: string): Promise<UnpublishResult>;
```

Add the initial value near `const initialCreative = hydrateCreative(persisted.creative);`:

```ts
const initialShares = hydrateShares(persisted.shares);
```

Add to the returned store object (after `creative: initialCreative,`):

```ts
    publishedShares: initialShares,
```

Add the three actions inside the returned object (place them right before `seedCreativeDemo:` or after it — anywhere in the object literal is fine):

```ts
    recordPublishedShare: (input) =>
      set({ publishedShares: addShare(get().publishedShares, input, crypto.randomUUID(), Date.now()) }),
    removePublishedShare: (id) =>
      set({ publishedShares: removeShare(get().publishedShares, id) }),
    unpublishShare: async (id) => {
      const share = get().publishedShares.find((s) => s.id === id);
      if (!share) return { ok: true, status: 200 };
      const result = await unpublishShowcase(share.path, share.token);
      if (result.ok) set({ publishedShares: removeShare(get().publishedShares, id) });
      return result;
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/shares.test.ts`
Expected: PASS (slice + store + projection).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state/store.ts src/state/persistence.ts tests/shares.test.ts
git commit -m "feat(unpublish): wire published-shares into store + persistence"
```

---

### Task 7: `PublishedLinks` card + record on publish

**Files:**
- Create: `src/components/creative/PublishedLinks.tsx`
- Modify: `src/components/creative/StudioOverview.tsx`
- Modify: `src/components/gallery/Gallery.tsx`
- Modify: `src/components/creative/ProjectsView.tsx`
- Modify: `src/styles/creative.css`

**Interfaces:**
- Consumes: `useStudio` selectors `publishedShares`, `unpublishShare`, `removePublishedShare`, `recordPublishedShare`; `Icon`.
- Produces: `<PublishedLinks />` (self-hides when empty).

- [ ] **Step 1: Create the component**

Create `src/components/creative/PublishedLinks.tsx`:

```tsx
import { useState } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type RowState = { k: 'idle' } | { k: 'busy' } | { k: 'err'; status: number; msg: string };

export function PublishedLinks() {
  const shares = useStudio((s) => s.publishedShares);
  const unpublishShare = useStudio((s) => s.unpublishShare);
  const removePublishedShare = useStudio((s) => s.removePublishedShare);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [copied, setCopied] = useState<string | null>(null);

  if (shares.length === 0) return null;

  const setRow = (id: string, st: RowState) => setRows((r) => ({ ...r, [id]: st }));

  const copy = async (id: string, url: string) => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard optional */
    }
  };

  const unpublish = async (id: string) => {
    setRow(id, { k: 'busy' });
    const r = await unpublishShare(id);
    if (r.ok) return; // store dropped the row; this component re-renders without it
    setRow(id, { k: 'err', status: r.status, msg: r.error ?? 'Unpublish failed' });
  };

  const sorted = [...shares].sort((a, b) => b.publishedAt - a.publishedAt);
  const now = Date.now();

  return (
    <section className="card creative-card published-links">
      <div className="creative-card-head">
        <h3>{Icon.link({ size: 15 })} Published links</h3>
        <span className="spacer" />
        <span className="chip">{shares.length}</span>
      </div>
      <ul className="published-list">
        {sorted.map((s) => {
          const st = rows[s.id] ?? { k: 'idle' as const };
          return (
            <li key={s.id} className="published-row">
              <div className="published-main">
                <span className="published-title">{s.title || 'Untitled'}</span>
                <a className="published-url mono" href={s.url} target="_blank" rel="noopener noreferrer">{s.url}</a>
                <span className="published-meta">{s.kind} · {relTime(s.publishedAt, now)}</span>
              </div>
              <div className="published-actions">
                <button className="btn tiny" type="button" onClick={() => void copy(s.id, s.url)}>{copied === s.id ? 'Copied' : 'Copy'}</button>
                <a className="btn tiny" href={s.url} target="_blank" rel="noopener noreferrer">Open</a>
                <button className="btn tiny danger" type="button" disabled={st.k === 'busy'} onClick={() => void unpublish(s.id)}>
                  {st.k === 'busy' ? 'Removing…' : 'Unpublish'}
                </button>
              </div>
              {st.k === 'err' ? (
                <div className="published-error" role="alert">
                  {st.status === 403 ? (
                    <>
                      <span>{Icon.error({ size: 12 })} Couldn’t verify ownership of this link.</span>
                      <button className="btn tiny" type="button" onClick={() => removePublishedShare(s.id)}>Forget locally</button>
                    </>
                  ) : (
                    <>
                      <span>{Icon.error({ size: 12 })} {st.msg}</span>
                      <button className="btn tiny" type="button" onClick={() => void unpublish(s.id)}>Retry</button>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Mount it in Studio Overview (both branches)**

In `src/components/creative/StudioOverview.tsx`:

Add the import after the `ReadinessRing` import:

```tsx
import { PublishedLinks } from './PublishedLinks';
```

In the empty-state branch, add `<PublishedLinks />` after the onboarding `</section>` (still inside `studio-page-inner`), so a projects-less user who published from the Gallery can still manage links:

```tsx
          </section>
          <PublishedLinks />
        </div>
      </main>
    );
  }
```

In the main return, add `<PublishedLinks />` as the last child of the `mission-grid` div (after the Velocity `</section>`, before the grid's closing `</div>`):

```tsx
          </section>

          <PublishedLinks />
        </div>
      </div>
    </main>
```

- [ ] **Step 3: Record on Gallery publish**

In `src/components/gallery/Gallery.tsx`, inside `Drawer`, add a selector near the other `useStudio` calls at the top of the component (after `const restoreSnapshot = useStudio((s) => s.restoreSnapshot);`):

```tsx
  const recordPublishedShare = useStudio((s) => s.recordPublishedShare);
```

In `publishShare`, replace:

```tsx
      const { url } = await publishShowcase(result.html, base);
      let copied = false;
      try { await navigator.clipboard?.writeText(url); copied = true; } catch { /* clipboard optional */ }
      setPublishState({ k: 'done', url, copied });
```

with:

```tsx
      const { url, path, token } = await publishShowcase(result.html, base);
      recordPublishedShare({ title, url, path, token, kind: 'gallery', sourceId: item.id });
      let copied = false;
      try { await navigator.clipboard?.writeText(url); copied = true; } catch { /* clipboard optional */ }
      setPublishState({ k: 'done', url, copied });
```

(`title` and `item` are already in scope in `publishShare`.)

- [ ] **Step 4: Record on Project publish**

In `src/components/creative/ProjectsView.tsx`, ensure `recordPublishedShare` is available. Add a selector where the other project actions are pulled from the store (near the top of the component with the other `useStudio((s) => ...)` calls):

```tsx
  const recordPublishedShare = useStudio((s) => s.recordPublishedShare);
```

In `publishProjectShowcase`, replace:

```tsx
      const { url } = await publishShowcase(result.html, built.name);
```

with:

```tsx
      const { url, path, token } = await publishShowcase(result.html, built.name);
      recordPublishedShare({ title: built.name, url, path, token, kind: 'project', sourceId: brain.id });
```

(`brain` is in scope in the component.)

- [ ] **Step 5: Styles**

Append to `src/styles/creative.css`:

```css
/* Published links manager (Studio Overview) */
.published-links .published-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.published-row { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; padding: 8px 10px; border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 10px; }
.published-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.published-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.published-url { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.published-meta { font-size: 11px; opacity: 0.55; text-transform: capitalize; }
.published-actions { display: flex; gap: 6px; align-items: center; }
.published-error { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; font-size: 12px; color: var(--danger, #ff6b6b); }
```

- [ ] **Step 6: Typecheck + run the full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — no type errors; all suites green (including the new `deleteToken`, `shares`, and updated `publish` tests).

- [ ] **Step 7: Commit**

```bash
git add src/components/creative/PublishedLinks.tsx src/components/creative/StudioOverview.tsx src/components/gallery/Gallery.tsx src/components/creative/ProjectsView.tsx src/styles/creative.css
git commit -m "feat(unpublish): Published-links card in Studio Overview + record on publish"
```

---

### Task 8: Deploy, version bump, live e2e verification, docs

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- Modify: `docs/superpowers/specs/2026-07-10-self-service-unpublish-design.md` (mark shipped — optional)

**Interfaces:** none (release + ops).

- [ ] **Step 1: Set the server secret + deploy both functions**

Set the project secret (32+ random bytes) and deploy. Via the Supabase MCP or CLI, on project `qfzguujtjloskyxcdbon` ("The Collective"):

- Set secret `LUMENDECK_DELETE_SECRET` to a fresh random value (e.g. `openssl rand -hex 32`).
- Deploy `publish-showcase` (now imports `_shared/deleteToken.ts`) and `unpublish-showcase`.

Expected: both functions listed as deployed; the secret present in the function env.

- [ ] **Step 2: Live e2e — publish then unpublish a real link**

Start the dev server (`preview_start`), open the app:
1. Render (or use an existing gallery item) → open its drawer → **Publish → link**. Confirm a public URL is returned and opens (200, shows the showcase).
2. Go to **Studio Overview** → the **Published links** card shows the new row.
3. Click **Unpublish** → the row disappears; re-opening the public URL now 404s (object gone).
4. (Negative) Temporarily corrupt a row's token in devtools state and Unpublish → the row stays with "Couldn't verify ownership" + **Forget locally**.

Capture a screenshot of the Published-links card for the user.

- [ ] **Step 3: Bump the version to 0.25.0**

Edit all four files to `0.25.0`:
- `package.json` → `"version": "0.25.0"`
- `src-tauri/tauri.conf.json` → `"version": "0.25.0"`
- `src-tauri/Cargo.toml` → `version = "0.25.0"` (the `[package]` version)
- `src-tauri/Cargo.lock` → the `lumendeck` package entry `version = "0.25.0"` (Read the file, Edit the exact block).

- [ ] **Step 4: Verify version parity + full suite + build**

Run: `npx vitest run tests/versionSync.test.ts && npx vitest run && npm run typecheck && npm run build`
Expected: versionSync PASS (all four sources == `0.25.0` == `APP_VERSION`); full suite green; typecheck clean; production build succeeds.

- [ ] **Step 5: Commit + open PR**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock docs/superpowers/specs/2026-07-10-self-service-unpublish-design.md
git commit -m "chore: bump to v0.25.0 (self-service unpublish)"
git push -u origin feature/self-service-unpublish
gh pr create --title "Self-service unpublish (v0.25.0)" --body "$(cat <<'EOF'
Take down any hosted share-link from a central place in the app.

- Stateless HMAC delete-token: publish returns { url, path, token }; unpublish-showcase
  recomputes HMAC(secret, path), constant-time compares, deletes on match (no new table).
- New `shares` state slice records every published link; Published-links card in Studio
  Overview with Copy / Open / Unpublish; 403 keeps the row + offers "Forget locally".
- New tests: deleteToken (algorithm + auth), shares (slice + store + projection), publish
  (path/token + unpublishShowcase). Live e2e: publish → row appears → unpublish → 404.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do NOT cut a public MSI release until the user explicitly says "release".

---

## Notes for the executor

- The Edge Functions are Deno and are not run by vitest. Their only non-glue logic (`authorizeUnpublish` / `deleteToken` / path validation) is fully unit-tested in `tests/deleteToken.test.ts` against the exact same file the functions import. The functions' HTTP glue is verified by the live e2e in Task 8.
- `crypto.randomUUID()` and `Date.now()` are used at runtime in the store/component — both are available in WebView2 and in vitest (Node/jsdom). (The Workflow-script restriction on `Date.now()` does NOT apply to app code.)
- If `publish-showcase` is redeployed but the secret is not yet set, it returns `token: ''`; `publishShowcase` then throws the "server not upgraded for unpublish" error rather than recording a tokenless share. Set the secret before/with the deploy.
