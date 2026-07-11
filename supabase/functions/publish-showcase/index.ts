// Supabase Edge Function: publish-showcase
//
// The ONLY write path into the public `lumendeck-showcases` bucket (the bucket has
// no anon-INSERT policy). Deployed to project "The Collective" with verify_jwt on,
// so callers must present the (public) anon key to invoke it. It validates the body
// is HTML <= 25MB, rate-limits per client IP via the `lumendeck_publish_events`
// table, then uploads with the SERVICE key and returns the public URL. This keeps
// the baked anon key from being able to write arbitrary storage directly.
//
// Deploy: `supabase functions deploy publish-showcase` (or the Supabase MCP).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { deleteToken } from '../_shared/deleteToken.ts';

const MAX_BYTES = 25 * 1024 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const BUCKET = 'lumendeck-showcases';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function slugify(s: string): string {
  return (s || 'showcase').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'showcase';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { html?: unknown; slug?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const html = body?.html;
  if (typeof html !== 'string' || html.length === 0) return json({ error: 'Missing html' }, 400);
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_BYTES) {
    return json({ error: `Showcase too large (${Math.round(bytes / 1e6)}MB > 25MB). Use poster-only or the file export.` }, 413);
  }
  const head = html.slice(0, 300).toLowerCase();
  if (!head.includes('<!doctype html') && !head.includes('<html')) return json({ error: 'Body is not an HTML document' }, 415);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count, error: countErr } = await admin
    .from('lumendeck_publish_events')
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('at', since);
  if (countErr) return json({ error: `Rate check failed: ${countErr.message}` }, 500);
  if ((count ?? 0) >= RATE_LIMIT) return json({ error: 'Rate limit exceeded — please try again later.' }, 429);

  const path = `${slugify(String(body?.slug ?? ''))}-${crypto.randomUUID()}.html`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, new Blob([html], { type: 'text/html' }), { contentType: 'text/html', upsert: false });
  if (upErr) return json({ error: `Upload failed: ${upErr.message}` }, 500);
  await admin.from('lumendeck_publish_events').insert({ ip });

  // Stateless HMAC capability token so the publisher — and only the publisher — can
  // later unpublish this exact object (see unpublish-showcase + _shared/deleteToken.ts).
  const secret = Deno.env.get('LUMENDECK_DELETE_SECRET');
  const token = secret ? await deleteToken(secret, path) : '';
  return json({ url: `${url}/storage/v1/object/public/${BUCKET}/${path}`, path, token }, 200);
});
