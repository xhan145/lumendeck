import { describe, expect, it, vi } from 'vitest';
import { publishShowcase, isPublishConfigured, PUBLISH_ENDPOINT, PUBLISH_MAX_BYTES, unpublishShowcase, UNPUBLISH_ENDPOINT } from '../src/bridge/publish';

describe('publishShowcase', () => {
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

  it('defaults an empty slug so the body always carries one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://x/y.html', path: 'y.html', token: 't' }), { status: 200 }));
    await publishShowcase('<html></html>', '', { fetchImpl: fetchMock });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).slug).toBe('showcase');
  });

  it('throws loudly with the server error message on a non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Rate limit exceeded — please try again later.' }), { status: 429 }));
    await expect(publishShowcase('<html></html>', 'p', { fetchImpl: fetchMock })).rejects.toThrow(/Publish failed \(429\): Rate limit exceeded/);
  });

  it('throws when the response omits a url (no silent success)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect(publishShowcase('<html></html>', 'p', { fetchImpl: fetchMock })).rejects.toThrow(/did not include a URL/);
  });

  it('throws when the response omits path or token (no half-recorded share)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://x/y.html' }), { status: 200 }));
    await expect(publishShowcase('<html></html>', 'p', { fetchImpl: fetchMock })).rejects.toThrow(/path.*token|token.*path|did not include/i);
  });
});

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

describe('config', () => {
  it('isPublishConfigured is true and the size cap is 25MB', () => {
    expect(isPublishConfigured()).toBe(true);
    expect(PUBLISH_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
