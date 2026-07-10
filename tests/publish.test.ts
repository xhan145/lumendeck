import { describe, expect, it, vi } from 'vitest';
import { publishShowcase, isPublishConfigured, PUBLISH_ENDPOINT, PUBLISH_MAX_BYTES } from '../src/bridge/publish';

describe('publishShowcase', () => {
  it('POSTs {html,slug} to the Edge Function with the anon bearer and returns its url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://x.supabase.co/storage/v1/object/public/lumendeck-showcases/neon-cat-UUID.html' }), { status: 200 }),
    );
    const res = await publishShowcase('<!doctype html><h1>hi</h1>', 'neon-cat', { fetchImpl: fetchMock });
    expect(res.url).toContain('/object/public/lumendeck-showcases/neon-cat-');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(PUBLISH_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ html: '<!doctype html><h1>hi</h1>', slug: 'neon-cat' });
  });

  it('defaults an empty slug so the body always carries one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: 'https://x/y.html' }), { status: 200 }));
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
});

describe('config', () => {
  it('isPublishConfigured is true and the size cap is 25MB', () => {
    expect(isPublishConfigured()).toBe(true);
    expect(PUBLISH_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
