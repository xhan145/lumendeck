# Self-service unpublish — design

**Date:** 2026-07-10
**Version target:** v0.25.0 (minor)
**Sub-project 1 of 3** (Unpublish → Creative intelligence → Temporal coherence)

## Problem

Hosted share-links (v0.24.0) let a creator publish a self-contained Showcase HTML
to a public Supabase bucket and get an unguessable URL. There is **no way to take
one down.** The publish path returns only `{ url }`, which the app copies to the
clipboard and persists nowhere — so the app has no record of what it published, and
the bucket accepts writes only through the `publish-showcase` Edge Function (no
anon-INSERT policy). The review of v0.24.0 flagged this gap.

"Unpublish" has two halves:

1. **Remember what I published** (client-side record).
2. **Authorize deleting it** (server-side) — with no user accounts.

## Core decision: authorizing an anonymous delete

Publishing is anonymous: anyone holding the public anon key can invoke the functions.
A delete endpoint therefore needs a secret only the original publisher holds.

**Chosen: stateless HMAC capability token (Approach A).**
At publish, the Edge Function computes `token = base64url(HMAC-SHA256(secret, path))`
and returns `{ url, path, token }`. The client stores those locally. To unpublish it
sends `{ path, token }`; the function recomputes the HMAC, constant-time compares, and
deletes the object on match.

- Zero new DB state, no migration, nothing to drift out of sync with storage.
- One new secret env var. Token is unguessable without the server secret.
- Limitation (accepted for v1): if the client loses its local record (reinstall /
  cleared data), that link can't be self-unpublished — inherent to anonymous sharing.
  The natural fix is auto-expiry, a separate follow-up (see Non-goals).

Rejected: **B — stored hashed token** (new table + migration + a row that can drift
from the storage object, for the same result); **C — real accounts** (overkill,
contradicts the anonymous-unlisted design).

## Architecture

Five well-bounded units:

### 1. Server — `unpublish-showcase` Edge Function + HMAC on publish

- **Project secret:** `LUMENDECK_DELETE_SECRET` (random ≥32 bytes), set on the
  Supabase project env (ops step, not committed).
- **`publish-showcase` (modified, additive):** after a successful upload, compute
  `token = base64url(HMAC-SHA256(secret, path))` and return `{ url, path, token }`.
  Existing callers reading only `.url` are unaffected.
- **`unpublish-showcase` (new):** `POST { path, token }`.
  - Validate `path` matches `^[a-z0-9][a-z0-9-]*\.html$` (rejects traversal and
    arbitrary-key deletes) → else `400`.
  - Recompute `HMAC-SHA256(secret, path)`, **constant-time** compare against the
    supplied token → mismatch `403`.
  - `storage.from('lumendeck-showcases').remove([path])`. Idempotent: an
    already-absent object still returns `{ ok: true }`.
  - `verify_jwt` on (anon key required to invoke). Same CORS block as publish.
- **No custom rate-limit on unpublish, deliberately:** the token is a 256-bit secret
  with no guessing oracle (one constant-time compare per request), so brute force is
  infeasible. Keeps the change migration-free and table-free.

### 2. Client bridge — `src/bridge/publish.ts`

- `PublishResult` gains `path: string; token: string;`. `publishShowcase` throws if
  the response omits either (no silent partial record).
- `UNPUBLISH_ENDPOINT = ${SUPABASE_URL}/functions/v1/unpublish-showcase`.
- `unpublishShowcase(path, token, opts?)` — POSTs `{ path, token }` with the anon
  bearer, throws loudly (`status + server error`) on non-OK, returns `{ ok: true }`.
  The client only **carries** the token (opaque string) — it never computes it.

### 2b. Shared token helper — `supabase/functions/_shared/deleteToken.ts`

- `deleteToken(secret, path)` — a small pure helper using only Web Crypto
  (`crypto.subtle` HMAC-SHA256) + `TextEncoder` + base64url, so the same file runs
  unchanged in **Deno** (both Edge Functions import it) and **Node/vitest** (the test
  imports it directly). Single source of truth for the algorithm — no duplicated copy
  to keep in sync.
- `isValidObjectPath(path)` — the `^[a-z0-9][a-z0-9-]*\.html$` guard, likewise shared
  by `unpublish-showcase` and its test.
- `constantTimeEqual(a, b)` — length-safe XOR-accumulate compare over the two token
  strings (Web Crypto exposes no `timingSafeEqual` in Deno).

### 3. State — new persisted slice `src/state/shares.ts`

Follows the house slice pattern (type + `defaultShares` + `hydrateShares`, additive
defensive migration), wired into `PersistedState` so pre-v0.25 saves still load.

```ts
interface PublishedShare {
  id: string;              // local uuid
  title: string;
  url: string;             // public link
  path: string;            // storage object key (for unpublish)
  token: string;           // HMAC delete token
  kind: 'gallery' | 'project';
  sourceId?: string;       // gallery item id or project/brain id
  publishedAt: number;     // epoch ms
}
```

- `hydrateShares` drops entries missing `url`/`path`/`token` (defensive).
- Store actions: `recordPublishedShare(s)`, `removePublishedShare(id)`, and an
  `unpublishShare(id)` thunk → `unpublishShowcase(path, token)` then
  `removePublishedShare(id)` **only on success**.
- Reactive slice `publishedShares` for the view (subscribe to the slice + `useMemo`
  where derived — never a getter-in-selector, per the Zustand gotcha).

### 4. UI — `src/components/creative/PublishedLinks.tsx`

- Self-contained list, newest first. Each row: title · relative date ·
  **Copy** · **Open** · **Unpublish**.
- **Unpublish** → confirm → busy → on success remove row + note; on failure keep row
  + show error (see Error handling).
- Empty list → renders nothing (no dead card).
- **Placement:** a "Published links" card mounted inside **Studio Overview** (the
  existing cross-project hub). Consistent with the central-manager choice; no new nav
  item, no shell wiring.
- Both publish paths (`Gallery.tsx`, `ProjectsView.tsx`) call `recordPublishedShare(...)`
  after a successful `publishShowcase`, tagging `kind` + `sourceId` + `title`.

## Data flow

**Publish:** click Publish → `publishShowcase(html, slug)` → Edge Fn uploads + returns
`{ url, path, token }` → client copies `url` to clipboard **and**
`recordPublishedShare({ title, url, path, token, kind, sourceId })` → row appears in
Studio Overview → Published links.

**Unpublish:** click Unpublish on a row → confirm → `unpublishShare(id)` →
`unpublishShowcase(path, token)` → Edge Fn HMAC-verifies + deletes the object →
client `removePublishedShare(id)` → row disappears.

## Error handling

- **Publish response missing `path`/`token`:** `publishShowcase` throws → no local
  record written (never a half-recorded share).
- **Unpublish 403 (ownership can't be verified, e.g. rotated secret):** do **not**
  silently drop the row (the link may still be live). Surface "Couldn't verify
  ownership" and offer an explicit **Forget locally** action (removes only the local
  record; the object stays live).
- **Unpublish network failure:** keep row, show error, allow retry.
- **Object already gone:** Edge Fn returns `200` → remove row (idempotent success).

## Testing

- `tests/publish.test.ts` (extend): `publishShowcase` returns `{url,path,token}` and
  throws when `path`/`token` are absent; `unpublishShowcase` POSTs `{path,token}` to
  `UNPUBLISH_ENDPOINT` with the anon bearer and throws loudly on non-OK.
- `tests/deleteToken.test.ts` (new): imports `supabase/functions/_shared/deleteToken.ts`
  directly. Asserts `deleteToken(secret, path)` is deterministic, differs across paths,
  and matches a known HMAC vector; `isValidObjectPath` accepts real publish paths and
  rejects traversal / non-`.html`; `constantTimeEqual` is correct. This is the exact
  code the Edge Functions run — one source of truth, not a mirror.
- `tests/shares.test.ts` (new): `hydrateShares` sanitizes/drops malformed entries;
  `recordPublishedShare`/`removePublishedShare` reducers are pure and correct.
- **Browser smoke:** publish from Gallery records a row in Studio Overview; Unpublish
  removes it; a forced 403 keeps the row and shows Forget-locally.

## Non-goals (YAGNI, deferred)

- **Auto-expiry / TTL** — the real fix for lost-token orphans; a clean separate
  follow-up, not bolted on here.
- Accounts / cross-device recovery.
- Server-side listing of all links (admin surface).
- In-place editing of a published showcase (unpublish + republish instead).

## Rollout

- Bump `package.json` / `tauri.conf.json` / `Cargo.toml` to `0.25.0`
  (`versionSync.test.ts` guards parity).
- Ops: set `LUMENDECK_DELETE_SECRET` on the Supabase project; deploy both Edge
  Functions (`publish-showcase` updated, `unpublish-showcase` new).
- No public MSI release until explicitly authorized ("release").
