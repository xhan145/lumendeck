/**
 * Hosted share-links: publish a self-contained Showcase HTML and get a public URL.
 *
 * Uploads go through the `publish-showcase` Supabase Edge Function (NOT a direct
 * storage write — the bucket has no anon-insert policy). The function validates
 * (HTML-only, ≤ 25MB), rate-limits per IP, and uploads with the service key, so the
 * baked anon key below can only INVOKE that gated function. The anon key is public
 * by design (guarded by the function + RLS). Object paths get a server-side random
 * UUID, so links are unguessable.
 */

export const SUPABASE_URL = 'https://qfzguujtjloskyxcdbon.supabase.co';
// Anon JWT (role=anon) — public by design; only lets the app invoke the
// publish-showcase Edge Function (which does the validated, rate-limited upload).
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmemd1dWp0amxvc2t5eGNkYm9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMTg3NTAsImV4cCI6MjA5NjU5NDc1MH0.kSoDgs4QRtBVvOzDM4e9tfhNi8hVRlMPkFx8A0PVY54';
export const BUCKET = 'lumendeck-showcases';
export const PUBLISH_ENDPOINT = `${SUPABASE_URL}/functions/v1/publish-showcase`;

/** The bucket/function reject showcases larger than this — check before uploading. */
export const PUBLISH_MAX_BYTES = 25 * 1024 * 1024;

export interface PublishResult {
  url: string;
}

export interface PublishOptions {
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

/** True when the publish endpoint is configured (guards the UI in stripped builds). */
export function isPublishConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Publish `html` via the Edge Function and return its public URL. Throws loudly
 * (status + server error message) on any non-OK response — never a silent success.
 * A 413 means the showcase exceeded the 25MB cap; a 429 is the per-IP rate limit.
 */
export async function publishShowcase(html: string, slug: string, opts: PublishOptions = {}): Promise<PublishResult> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(PUBLISH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ html, slug: slug || 'showcase' }),
  });
  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!res.ok) {
    throw new Error(`Publish failed (${res.status}): ${data?.error ?? res.statusText}`);
  }
  if (!data?.url) throw new Error('Publish response did not include a URL.');
  return { url: data.url };
}
