import { describe, expect, it, vi } from 'vitest';
import { HttpAdapter } from '../src/bridge/httpAdapter';
import { MockAdapter } from '../src/bridge/mockAdapter';

const OPTS = { frames: 14, fps: 7, motion: 127, seed: 0, modelPath: '/models/svd', jobId: 'abcabcabcabc' };

describe('httpAdapter.animateStill', () => {
  it('POSTs {image,modelPath,...} to /animate-svd and maps the mp4 result', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/progress/')) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ video_base64: 'AAA', mediaType: 'video', mimeType: 'video/mp4', extension: 'mp4', seed: 5, engine: 'svd' }), { status: 200 });
    });
    const a = new HttpAdapter('http://localhost:8787', fetchMock as unknown as typeof fetch);
    const r = await a.animateStill('BASE64IMG', OPTS);
    expect(r.mediaType).toBe('video');
    expect(r.mimeType).toBe('video/mp4');
    expect(r.dataUrl.startsWith('data:video/mp4;base64,')).toBe(true);
    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/animate-svd'))!;
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    // The adapter maps the UI names -> the worker's clamp keys (num_frames / motion_bucket_id).
    expect(body).toMatchObject({ image: 'BASE64IMG', modelPath: '/models/svd', num_frames: 14, fps: 7, motion_bucket_id: 127 });
  });

  it('throws loudly when the bridge returns an error (no silent success)', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/progress/')) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ error: 'Not enough VRAM for SVD at these settings.' }), { status: 200 });
    });
    const a = new HttpAdapter('http://localhost:8787', fetchMock as unknown as typeof fetch);
    await expect(a.animateStill('IMG', OPTS)).rejects.toThrow(/VRAM/);
  });

  it('listSvdModels GETs /svd-models', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [{ id: 's', name: 's', path: '/m/s', kind: 'folder' }] }), { status: 200 }));
    const a = new HttpAdapter('http://localhost:8787', fetchMock as unknown as typeof fetch);
    const models = await a.listSvdModels();
    expect(models).toHaveLength(1);
    expect(models[0].path).toBe('/m/s');
  });
});

describe('mockAdapter.animateStill', () => {
  it('returns an honest labeled mock video (never pretends to be SVD)', async () => {
    const r = await new MockAdapter().animateStill('IMG', OPTS);
    expect(r.mediaType).toBe('video');
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason ?? '').toMatch(/mock|SVD|real backend/i);
  });
  it('mock listSvdModels is empty', async () => {
    expect(await new MockAdapter().listSvdModels()).toEqual([]);
  });
});
