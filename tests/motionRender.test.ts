import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPatches,
  buildMotionRenderJobs,
  planMotionRender,
  type MotionParamPatch,
} from '../src/core/motion/renderPlan';
import { HttpAdapter } from '../src/bridge/httpAdapter';
import type { RenderJob } from '../src/bridge/adapter';
import { buildManifest } from '../src/core/manifest';
import { createDefaultWorkflow, findNode } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';
import type { Keyframe, MotionClip, MotionTrack } from '../src/core/motion/types';

// ---------------------------------------------------------------------------
// helpers (mirror tests/motion.test.ts) — build clips bound to a real workflow
// ---------------------------------------------------------------------------
type KfLiteral = Omit<Keyframe, 'id'> & { id?: string };
const track = (nodeId: string, param: string, kfs: KfLiteral[]): MotionTrack => ({
  id: `t_${nodeId}_${param}`,
  nodeId,
  param,
  keyframes: kfs.map((k, i) => ({ id: k.id ?? `k${i}`, ...k })),
});
const clip = (tracks: MotionTrack[], over: Partial<MotionClip> = {}): MotionClip => ({
  id: 'c1', name: 'Sweep', duration: 3, fps: 24, loop: true, tracks, orbMotions: {}, ...over,
});

/** A workflow with a sampler + a cfg 4->18->7 track bound to that sampler. */
function sweepFixture() {
  const wf = createDefaultWorkflow();
  const sampler = findNode(wf, 'sampler')!;
  const c = clip(
    [track(sampler.id, 'cfg', [{ t: 0, value: 4 }, { t: 1.5, value: 18 }, { t: 3, value: 7 }])],
    { duration: 3 },
  );
  return { wf, sampler, clip: c };
}

// ---------------------------------------------------------------------------
// applyPatches — pure, nested set, others untouched
// ---------------------------------------------------------------------------
describe('applyPatches', () => {
  it('sets nodeId.param on a clone and leaves the input workflow untouched (pure)', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const cfgBefore = sampler.params.cfg;
    const patches: MotionParamPatch[] = [{ nodeId: sampler.id, param: 'cfg', value: 13.5 }];

    const next = applyPatches(wf, patches);

    // Input is unchanged (structural purity).
    expect(findNode(wf, 'sampler')!.params.cfg).toBe(cfgBefore);
    expect(next).not.toBe(wf);
    // Output carries the patched value.
    expect(findNode(next, 'sampler')!.params.cfg).toBe(13.5);
  });

  it('applies multiple patches across nodes; unrelated nodes are shared by reference', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const canvas = findNode(wf, 'canvas')!;
    const promptBefore = findNode(wf, 'prompt')!;

    const next = applyPatches(wf, [
      { nodeId: sampler.id, param: 'cfg', value: 9 },
      { nodeId: sampler.id, param: 'steps', value: 20 },
      { nodeId: canvas.id, param: 'width', value: 768 },
    ]);

    expect(findNode(next, 'sampler')!.params.cfg).toBe(9);
    expect(findNode(next, 'sampler')!.params.steps).toBe(20);
    expect(findNode(next, 'canvas')!.params.width).toBe(768);
    // A node touched by no patch is the SAME object (only patched nodes cloned).
    expect(findNode(next, 'prompt')).toBe(promptBefore);
  });

  it('empty patch list returns a workflow that still renders the base values', () => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const next = applyPatches(wf, []);
    expect(findNode(next, 'sampler')!.params.cfg).toBe(sampler.params.cfg);
  });

  it('a patch naming a missing node is a no-op (stale clip never corrupts the graph)', () => {
    const wf = createDefaultWorkflow();
    const next = applyPatches(wf, [{ nodeId: 'ghost', param: 'cfg', value: 99 }]);
    expect(next.nodes).toHaveLength(wf.nodes.length);
  });
});

// ---------------------------------------------------------------------------
// buildMotionRenderJobs — N jobs, per-frame cfg, frames=1, empty clip
// ---------------------------------------------------------------------------
describe('buildMotionRenderJobs', () => {
  it('emits exactly `frames` jobs with aligned frameTimes', () => {
    const { wf, clip: c } = sweepFixture();
    const { jobs, frameTimes } = buildMotionRenderJobs(wf, c, { frames: 4 });
    expect(jobs).toHaveLength(4);
    expect(frameTimes).toEqual([0, 1, 2, 3]); // duration 3, 4 frames -> step 1
    // frameTimes match planMotionRender exactly.
    expect(frameTimes).toEqual(planMotionRender(c, { frames: 4 }).map((f) => f.t));
  });

  it('bakes the per-frame cfg sweep into each job (4 -> 18 -> 7 at frames=3)', () => {
    const { wf, clip: c } = sweepFixture();
    const { jobs } = buildMotionRenderJobs(wf, c, { frames: 3 }); // t = 0, 1.5, 3
    expect(jobs.map((j) => j.cfg)).toEqual([4, 18, 7]);
  });

  it('frames=1 renders a single job sampled at t=0', () => {
    const { wf, clip: c } = sweepFixture();
    const { jobs, frameTimes } = buildMotionRenderJobs(wf, c, { frames: 1 });
    expect(jobs).toHaveLength(1);
    expect(frameTimes).toEqual([0]);
    expect(jobs[0].cfg).toBe(4); // first keyframe value
  });

  it('empty clip -> jobs at the base cfg (no patches), still one per frame', () => {
    const wf = createDefaultWorkflow();
    const baseCfg = findNode(wf, 'sampler')!.params.cfg;
    const empty = clip([], { duration: 2 });
    const { jobs } = buildMotionRenderJobs(wf, empty, { frames: 3 });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.cfg === baseCfg)).toBe(true);
  });

  it('produces full RenderJob shapes (same as buildRenderJob) per frame', () => {
    const { wf, clip: c } = sweepFixture();
    const { jobs } = buildMotionRenderJobs(wf, c, { frames: 2 });
    const j = jobs[0];
    // spot-check the RenderJob contract fields exist
    expect(j).toHaveProperty('prompt');
    expect(j).toHaveProperty('resolvedPrompt');
    expect(j).toHaveProperty('width');
    expect(j).toHaveProperty('height');
    expect(j).toHaveProperty('sampler');
  });
});

// ---------------------------------------------------------------------------
// HttpAdapter.renderMotion — result mapping + fallback passthrough
// ---------------------------------------------------------------------------
describe('HttpAdapter.renderMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jobsOf = (): RenderJob[] => {
    const { wf, clip: c } = sweepFixture();
    return buildMotionRenderJobs(wf, c, { frames: 2 }).jobs;
  };

  it('POSTs /render-motion and maps video_base64 -> dataUrl (mp4)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          video_base64: 'AAAA',
          mediaType: 'video',
          mimeType: 'video/mp4',
          extension: 'mp4',
          seed: 321,
          frameCount: 2,
          fps: 12,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpAdapter('http://bridge.local');

    const result = await adapter.renderMotion(jobsOf(), { fps: 12, format: 'mp4', jobId: 'jid' });

    expect(result.mediaType).toBe('video');
    expect(result.mimeType).toBe('video/mp4');
    expect(result.extension).toBe('mp4');
    expect(result.seed).toBe(321);
    expect(result.dataUrl).toBe('data:video/mp4;base64,AAAA');
    expect(result.fallback).toBeFalsy();
    // The POST body carries jobs/fps/format/jobId.
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/render-motion'))!;
    expect(String(call[0])).toBe('http://bridge.local/render-motion');
    const body = JSON.parse(call[1].body);
    expect(body.fps).toBe(12);
    expect(body.format).toBe('mp4');
    expect(body.jobId).toBe('jid');
    expect(body.jobs).toHaveLength(2);
  });

  it('maps a webm response to a video/webm dataUrl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ video_base64: 'V0VC', mediaType: 'video', mimeType: 'video/webm', extension: 'webm', seed: 9 }),
        { status: 200 },
      ),
    ));
    const result = await new HttpAdapter('http://bridge.local').renderMotion(jobsOf(), { fps: 12, format: 'webm', jobId: 'jw' });
    expect(result.mediaType).toBe('video');
    expect(result.mimeType).toBe('video/webm');
    expect(result.extension).toBe('webm');
    expect(result.dataUrl).toBe('data:video/webm;base64,V0VC');
  });

  it('maps a frame-sequence response to an application/zip archive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ video_base64: 'UEsFBg==', mediaType: 'archive', mimeType: 'application/zip', extension: 'zip', seed: 3 }),
        { status: 200 },
      ),
    ));
    const result = await new HttpAdapter('http://bridge.local').renderMotion(jobsOf(), { fps: 8, format: 'frames', jobId: 'jf' });
    expect(result.mediaType).toBe('archive');
    expect(result.mimeType).toBe('application/zip');
    expect(result.extension).toBe('zip');
    expect(result.dataUrl).toBe('data:application/zip;base64,UEsFBg==');
  });

  it('falls back to format-derived mime when the response omits it (webm/frames)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ video_base64: 'ZZ', seed: 1 }), { status: 200 }),
    ));
    const r = await new HttpAdapter('http://bridge.local').renderMotion(jobsOf(), { fps: 8, format: 'webm', jobId: 'jwm' });
    expect(r.mimeType).toBe('video/webm');
    expect(r.extension).toBe('webm');
  });

  it('passes the fallback flag + reason through (never silent)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          video_base64: 'BBBB',
          mediaType: 'video',
          mimeType: 'image/gif',
          extension: 'gif',
          seed: 7,
          fallback: true,
          fallbackReason: 'diffusers unavailable; procedural frames',
        }),
        { status: 200 },
      ),
    ));
    const adapter = new HttpAdapter('http://bridge.local');

    const result = await adapter.renderMotion(jobsOf(), { fps: 10, format: 'gif', jobId: 'j2' });

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toMatch(/diffusers unavailable/);
    expect(result.mimeType).toBe('image/gif');
    expect(result.dataUrl).toBe('data:image/gif;base64,BBBB');
  });

  it('throws loudly on an HTTP error (surfaces like /generate)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const adapter = new HttpAdapter('http://bridge.local');
    await expect(adapter.renderMotion(jobsOf(), { fps: 12, format: 'mp4', jobId: 'j3' }))
      .rejects.toThrow(/\/render-motion failed \(500\)/);
  });

  it('throws when the response omits video data (no silent success)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ seed: 1 }), { status: 200 }),
    ));
    const adapter = new HttpAdapter('http://bridge.local');
    await expect(adapter.renderMotion(jobsOf(), { fps: 12, format: 'mp4', jobId: 'j4' }))
      .rejects.toThrow(/did not include video data/);
  });
});

// ---------------------------------------------------------------------------
// manifest — optional motion fields
// ---------------------------------------------------------------------------
describe('buildManifest motion fields', () => {
  it('omits `motion` for an ordinary render (backward compatible)', () => {
    const m = buildManifest(createDefaultWorkflow(), DEMO_SHELF, '0.1.0', new Date());
    expect(m.motion).toBeUndefined();
  });

  it('records the motion clip fields when a motion descriptor is passed', () => {
    const wf = createDefaultWorkflow();
    const m = buildManifest(wf, DEMO_SHELF, '0.14.0', new Date('2026-07-06T00:00:00Z'), [], {
      clipId: 'c1',
      clipName: 'Sweep',
      frames: 12,
      fps: 12,
      durationSec: 3,
    });
    expect(m.motion).toEqual({ clipId: 'c1', clipName: 'Sweep', frames: 12, fps: 12, durationSec: 3 });
    // Base workflow is still captured so the sequence is reproducible.
    expect(m.graph).toBe(wf);
    expect(m.graphVersion).toBe(wf.version);
  });
});
