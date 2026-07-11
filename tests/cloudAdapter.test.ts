import { describe, expect, it } from 'vitest';
import { CloudAdapter } from '../src/bridge/cloudAdapter';
import { buildRenderJob } from '../src/bridge/adapter';
import { createDefaultWorkflow } from '../src/core/workflow';

interface RecordedCall { url: string; method: string; body: unknown }

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; json?: unknown }) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = handler(url, init);
    return new Response(JSON.stringify(out.json ?? {}), {
      status: out.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function job() {
  return buildRenderJob(createDefaultWorkflow());
}

describe('CloudAdapter', () => {
  it('POSTs provider/model/jobId to /cloud/generate and maps an image result', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.includes('/cloud/generate')) {
        return { json: { image_base64: 'QUJD', seed: '42', mediaType: 'image', mimeType: 'image/png', extension: 'png' } };
      }
      return { json: { phase: 'unknown' } };
    });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    adapter.setProvider('openai');
    adapter.setModel('gpt-image-1');
    const result = await adapter.generate(job());
    const post = calls.find((c) => c.url.includes('/cloud/generate'));
    expect(post?.method).toBe('POST');
    const body = post?.body as Record<string, unknown>;
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-image-1');
    expect(typeof body.jobId).toBe('string');
    expect(result.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(result.mediaType).toBe('image');
    expect(result.seed).toBe(42);
  });

  it('maps a video result to video/mp4', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/cloud/generate')
        ? { json: { video_base64: 'TVBG', mediaType: 'video', mimeType: 'video/mp4', extension: 'mp4', seed: '7' } }
        : { json: { phase: 'unknown' } });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    adapter.setProvider('runway');
    adapter.setModel('gen4_turbo');
    const result = await adapter.generate(job());
    expect(result.dataUrl).toBe('data:video/mp4;base64,TVBG');
    expect(result.mediaType).toBe('video');
    expect(result.extension).toBe('mp4');
  });

  it('throws the bridge error message on a 502 CloudError', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/cloud/generate')
        ? { status: 502, json: { error: 'openai: HTTP 401: invalid key' } }
        : { json: { phase: 'unknown' } });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    await expect(adapter.generate(job())).rejects.toThrow(/openai: HTTP 401/);
  });

  it('throws when the response has no media payload', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/cloud/generate') ? { json: { seed: '1' } } : { json: { phase: 'unknown' } });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    await expect(adapter.generate(job())).rejects.toThrow(/media data/);
  });

  it('listProviders returns the providers array and saveKey posts provider+key', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.includes('/cloud/providers')) {
        return { json: { providers: [{ id: 'openai', label: 'OpenAI Images', kind: 'image', models: [], hasKey: false }] } };
      }
      if (url.includes('/cloud/keys')) return { json: { ok: true, hasKey: true } };
      return { json: {} };
    });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    const providers = await adapter.listProviders();
    expect(providers[0].id).toBe('openai');
    const saved = await adapter.saveKey('openai', 'sk-x');
    expect(saved).toBe(true);
    const post = calls.find((c) => c.url.includes('/cloud/keys'));
    expect(post?.body).toEqual({ provider: 'openai', key: 'sk-x' });
  });

  it('recovers a parked result when the generate connection drops mid-render', async () => {
    let generateCalls = 0;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/cloud/generate') && init?.method === 'POST') {
        generateCalls += 1;
        throw new TypeError('network connection was lost');
      }
      if (url.includes('/progress/')) {
        return new Response(JSON.stringify({ phase: 'done' }), { status: 200 });
      }
      if (url.includes('/cloud/result/')) {
        return new Response(
          JSON.stringify({ image_base64: 'UkVDT1ZFUkVE', seed: '11', mediaType: 'image', mimeType: 'image/png', extension: 'png' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    adapter.setProvider('openai');
    adapter.setModel('gpt-image-1');
    const result = await adapter.generate(job());
    expect(generateCalls).toBe(1);
    expect(result.dataUrl).toBe('data:image/png;base64,UkVDT1ZFUkVE');
    expect(result.seed).toBe(11);
  }, 15000);

  it('is loudly unsupported for SVD/evolve/motion and lists no SVD models', async () => {
    const { impl } = stubFetch(() => ({ json: {} }));
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    await expect(adapter.animateStill()).rejects.toThrow(/Cloud backend/);
    await expect(adapter.evolveStep()).rejects.toThrow(/Cloud backend/);
    await expect(adapter.renderMotion()).rejects.toThrow(/Cloud backend/);
    await expect(adapter.listSvdModels()).resolves.toEqual([]);
  });
});
