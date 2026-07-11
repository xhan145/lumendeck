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
