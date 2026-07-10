/**
 * Hosted share-links: upload a self-contained Showcase HTML to a PUBLIC Supabase
 * Storage bucket and return a public URL. Plain `fetch` against the Storage REST
 * API — no `supabase-js` dependency.
 *
 * The bucket `lumendeck-showcases` (project "The Collective") is public-read,
 * HTML-only, 25MB-capped, with an anon INSERT policy. The anon key below is
 * PUBLIC BY DESIGN (a Supabase anon/publishable key, guarded by RLS + the bucket's
 * MIME/size limits) — it is safe to commit to the public repo. Object paths carry
 * a random UUID so links are unguessable.
 */

export const SUPABASE_URL = 'https://qfzguujtjloskyxcdbon.supabase.co';
// Legacy anon JWT (role=anon) — verified working for the storage upload path.
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmemd1dWp0amxvc2t5eGNkYm9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTg3NTAsImV4cCI6MjA5NjU5NDc1MH0.kSoDgs4QRtBVvOzDM4e9tfhNi8hVRlMPkFx8A0PVY54';
export const BUCKET = 'lumendeck-showcases';

export interface PublishResult {
  url: string;
}

export interface PublishOptions {
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  /** injectable unguessable id generator for tests */
  randomId?: () => string;
}

/** True when the publish endpoint is configured (guards the UI in stripped builds). */
export function isPublishConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && BUCKET);
}

function defaultRandomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Upload `html` as `<slug>-<uuid>.html` to the public bucket and return its public
 * URL. Throws loudly (status + body) on any non-OK response — never a silent
 * success. A 413 means the showcase exceeded the 25MB bucket cap; a 415 means a
 * non-HTML body slipped through.
 */
export async function publishShowcase(html: string, slug: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const f = opts.fetchImpl ?? fetch;
  const id = (opts.randomId ?? defaultRandomId)();
  const path = `${slug || 'showcase'}-${id}.html`;
  const res = await f(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'text/html',
      'x-upsert': 'false',
    },
    body: html,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Publish failed (${res.status}): ${detail.slice(0, 200) || res.statusText}`);
  }
  return { url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}` };
}
