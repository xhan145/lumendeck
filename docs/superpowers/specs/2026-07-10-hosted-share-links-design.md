# Hosted Share-links — design spec

**Date:** 2026-07-10
**Status:** Approved (brainstorming — "do the queued"; user chose "Supabase, reuse
existing project"). Phase 2 of "Creative OS + sharing", after the file-first
Showcase (v0.21).
**Scope:** A "Publish → link" flow that uploads the self-contained Showcase HTML to
a public Supabase Storage bucket and returns a public URL. Out of scope: accounts,
edit/delete of published links, a hosted gallery index, moderation tooling.

## Problem

The Showcase (v0.21) produces a self-contained `.html` file the user sends via
their own channels. There is no one-click way to get a **link** — the more
"modern share" for showing work.

## Backend (provisioned + hardened)

Supabase project **"The Collective"** (`qfzguujtjloskyxcdbon`) — the shared project
`lumendeck-site` already reuses.

- Bucket `lumendeck-showcases` — **public-read**, `file_size_limit = 26214400`
  (25 MB), `allowed_mime_types = ['text/html']`. **No anon-INSERT policy** —
  direct anonymous writes are blocked (403).
- **`publish-showcase` Edge Function** (`verify_jwt` on) is the ONLY write path: it
  validates the body is HTML ≤ 25 MB, rate-limits per client IP (≤ 20/hour via the
  `lumendeck_publish_events` table, RLS-locked to the service role), then uploads
  with the **service key** to a `<slug>-<uuid>.html` path and returns the public
  URL. Verified live: valid HTML → 200 + fetchable URL; non-HTML → 415; missing JWT
  → 401; direct anon storage write → 403.

**Security model (honest).** The original design (open anon-INSERT bucket) was an
anonymous arbitrary-HTML-hosting primitive on the shared production project — an
adversarial review flagged that abuse could get the whole Collective project
suspended. Hardened per the user's choice ("Edge Function gateway, keep the
project"): the baked anon key can only *invoke* the validated, rate-limited
function, never write storage directly. Residual, accepted trade-offs: the function
is still publicly invokable (bounded by the per-IP rate limit + HTML/size caps);
published links are public-by-URL (unguessable UUID) and stay up until the project
owner removes them (no self-service unpublish yet); it still shares the Collective
project (rate limit contains, but does not eliminate, abuse pressure).

## Architecture

### `src/bridge/publish.ts` (new)

- Constants: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the legacy anon JWT, verified
  working; public-safe), `BUCKET = 'lumendeck-showcases'`.
- `publishShowcase(html: string, slug: string, opts?: { fetchImpl?; randomId? }):
  Promise<{ url: string }>` — POSTs the HTML to
  `${URL}/storage/v1/object/${BUCKET}/${slug}-${uuid}.html` with `apikey` +
  `Authorization: Bearer` headers and `Content-Type: text/html`; returns the public
  URL `${URL}/storage/v1/object/public/${BUCKET}/<path>`. No `supabase-js`
  dependency — plain `fetch`. `opts` inject fetch + id for tests. Loud on non-OK
  (throws with status + body).
- `isPublishConfigured(): boolean` — true when the URL/key constants are set (guards
  the UI so a stripped build degrades rather than errors).

### UI

- **Gallery drawer** + **Creative-OS Projects**: a **"Publish → link"** button next
  to "Share showcase". On click: build the same showcase HTML (reusing
  `buildShowcaseHtml` + `showcaseInputFromRenders`), `publishShowcase(...)`, then
  copy the URL to the clipboard and show a status with the link (+ a one-line
  "anyone with the link can view" note). Loud error state on failure.
- The publish action is desktop+web safe (plain fetch); no Tauri dependency.

## Data flow

```
render/project → showcaseInputFromRenders → buildShowcaseHtml → html
    → publishShowcase(html, slug) → POST storage REST (anon key)
        → { url: https://…/object/public/lumendeck-showcases/<slug>-<uuid>.html }
        → copy to clipboard + show link
```

## Error handling

- Upload non-OK (413 too large, 415 bad MIME, network) → throw a loud error the UI
  surfaces ("Publish failed: …"); never a silent success.
- Oversized showcase (> 25 MB, e.g. a big embedded video) → the 413 surfaces; the UI
  suggests poster-only / the file export instead.
- `isPublishConfigured()` false → the button is hidden/disabled with a note.

## Testing

`tests/publish.test.ts` (mock `fetch`):
- POSTs to the correct `…/object/lumendeck-showcases/<slug>-<uuid>.html` with the
  `apikey` + `Authorization` headers + `text/html` body; returns the public URL.
- a non-OK response throws with the status + body (loud).
- the object path is randomized (two calls → different paths) and slug-prefixed.
- `isPublishConfigured()` reflects the constants.

A real end-to-end upload was verified against the live bucket during design (200 +
public fetch + MIME rejection); the app path is unit-tested with a mocked fetch.

## Rollout

Single PR: `publish.ts` + tests + the two UI actions + CSS. Version bump to
**0.24.0**. The anon key + URL are committed (public-safe). Update the memory with
the bucket + key facts.

## Out of scope (tracked)

- Accounts / auth-gated publishing, edit/unpublish, a hosted browsable gallery.
- Moderation tooling, analytics, custom domains.
