import { describe, expect, it, vi } from 'vitest';
import { publishShowcase, isPublishConfigured, SUPABASE_URL, BUCKET } from '../src/bridge/publish';

describe('publishShowcase', () => {
  it('POSTs the HTML to the storage bucket with auth headers and returns the public URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Key: 'x' }), { status: 200 }));
    const res = await publishShowcase('<h1>hi</h1>', 'neon-cat', { fetchImpl: fetchMock, randomId: () => 'FIXEDID' });
    expect(res.url).toBe(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/neon-cat-FIXEDID.html`);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/neon-cat-FIXEDID.html`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('text/html');
    expect(init.headers.apikey).toBeTruthy();
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(init.body).toBe('<h1>hi</h1>');
  });

  it('throws loudly on a non-OK response (never a silent success)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('too big', { status: 413 }));
    await expect(publishShowcase('<h1>x</h1>', 'p', { fetchImpl: fetchMock })).rejects.toThrow(/Publish failed \(413\)/);
  });

  it('randomizes the object path per call (unguessable links)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    let n = 0;
    await publishShowcase('a', 's', { fetchImpl: fetchMock, randomId: () => `id${n++}` });
    await publishShowcase('a', 's', { fetchImpl: fetchMock, randomId: () => `id${n++}` });
    expect(String(fetchMock.mock.calls[0][0])).not.toBe(String(fetchMock.mock.calls[1][0]));
  });

  it('slug-prefixes the object path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await publishShowcase('a', 'my-slug', { fetchImpl: fetchMock, randomId: () => 'Z' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/my-slug-Z.html');
  });
});

describe('isPublishConfigured', () => {
  it('is true when the URL + key constants are set', () => {
    expect(isPublishConfigured()).toBe(true);
  });
});
