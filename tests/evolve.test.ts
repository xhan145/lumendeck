import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEvolveKnobs,
  clampKnob,
  crossover,
  genomeToPatches,
  mutate,
  randomGenome,
  renormalizeWeights,
  seedFromString,
  selectTopK,
  type Genome,
  type KnobDesc,
} from '../src/core/evolve/genome';
import { mulberry32 } from '../src/core/prompt/wildcards';
import { applyPatches } from '../src/core/motion/renderPlan';
import { buildRenderJob, type RenderJob } from '../src/bridge/adapter';
import { HttpAdapter } from '../src/bridge/httpAdapter';
import { MockAdapter } from '../src/bridge/mockAdapter';
import { buildManifest } from '../src/core/manifest';
import { createDefaultWorkflow, findNode } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';

const KNOBS = buildEvolveKnobs('SD1.5');
const inBounds = (genome: Genome, knobs: KnobDesc[]) =>
  genome.every((v, i) => {
    const k = knobs[i];
    const ok = v >= Math.min(k.min, k.max) && v <= Math.max(k.min, k.max);
    return ok && (!k.integer || Number.isInteger(v));
  });

// ===========================================================================
// genome — pure operators (bounds + seeded determinism)
// ===========================================================================
describe('buildEvolveKnobs', () => {
  it('lists only the EFFECTIVE knobs — cfg/steps/seed for a standard model (no inert denoise)', () => {
    // The worker never reads sampler.denoise (img2img uses the Load Image strength),
    // so denoise is deliberately NOT a knob. cfg/steps/seed for non-turbo text2img.
    expect(KNOBS.map((k) => k.param)).toEqual(['cfg', 'steps', 'seed']);
    expect(KNOBS.find((k) => k.param === 'steps')?.integer).toBe(true);
    expect(KNOBS.find((k) => k.param === 'seed')?.integer).toBe(true);
    expect(KNOBS.find((k) => k.param === 'cfg')?.integer).toBeFalsy();
  });

  it('drops the inert cfg knob and widens steps for turbo models', () => {
    const turbo = buildEvolveKnobs({ family: 'SD1.5', isTurbo: true });
    expect(turbo.map((k) => k.param)).toEqual(['steps', 'seed']); // turbo ignores cfg
    // steps must sweep the effective turbo range (1..8), not 8..40 (which the worker
    // would clamp to a constant 8 -> a dead dimension).
    const steps = turbo.find((k) => k.param === 'steps')!;
    expect(steps.min).toBe(1);
    expect(steps.max).toBe(8);
  });

  it('adds an img2img strength knob (on the Load Image node) only when an init image is present', () => {
    const plain = buildEvolveKnobs({ family: 'SD1.5', hasInitImage: false });
    expect(plain.some((k) => k.param === 'strength')).toBe(false);
    const img = buildEvolveKnobs({ family: 'SD1.5', hasInitImage: true });
    const strength = img.find((k) => k.param === 'strength')!;
    expect(strength).toBeTruthy();
    expect(strength.node).toBe('imageLoader');
  });

  it('adapts the cfg range by model family (SDXL runs lower)', () => {
    const xl = buildEvolveKnobs('SDXL').find((k) => k.param === 'cfg')!;
    const base = buildEvolveKnobs('SD1.5').find((k) => k.param === 'cfg')!;
    expect(xl.max).toBeLessThan(base.max);
  });
});

describe('clampKnob', () => {
  it('clamps to [min,max] and rounds integer knobs', () => {
    expect(clampKnob(999, { param: 'cfg', min: 1, max: 16 })).toBe(16);
    expect(clampKnob(-5, { param: 'cfg', min: 1, max: 16 })).toBe(1);
    expect(clampKnob(23.7, { param: 'steps', min: 8, max: 40, integer: true })).toBe(24);
    expect(clampKnob(NaN, { param: 'cfg', min: 3, max: 9 })).toBe(3);
  });
});

describe('seedFromString', () => {
  it('is deterministic and order-sensitive', () => {
    expect(seedFromString('neon cat')).toBe(seedFromString('neon cat'));
    expect(seedFromString('neon cat')).not.toBe(seedFromString('cat neon'));
  });
});

describe('randomGenome', () => {
  it('draws every gene within bounds (integers where required)', () => {
    const g = randomGenome(KNOBS, mulberry32(42));
    expect(g).toHaveLength(KNOBS.length);
    expect(inBounds(g, KNOBS)).toBe(true);
  });

  it('is deterministic for the same seeded rng', () => {
    expect(randomGenome(KNOBS, mulberry32(7))).toEqual(randomGenome(KNOBS, mulberry32(7)));
    expect(randomGenome(KNOBS, mulberry32(7))).not.toEqual(randomGenome(KNOBS, mulberry32(8)));
  });
});

describe('mutate', () => {
  it('keeps every gene within bounds (integers stay integral)', () => {
    const g = randomGenome(KNOBS, mulberry32(1));
    const rng = mulberry32(99);
    for (let i = 0; i < 50; i++) {
      const m = mutate(g, KNOBS, 1, rng);
      expect(inBounds(m, KNOBS)).toBe(true);
    }
  });

  it('rate 0 leaves an in-bounds genome unchanged', () => {
    const g = randomGenome(KNOBS, mulberry32(3));
    expect(mutate(g, KNOBS, 0, mulberry32(123))).toEqual(g);
  });

  it('is deterministic for the same seeded rng', () => {
    const g = randomGenome(KNOBS, mulberry32(5));
    expect(mutate(g, KNOBS, 0.3, mulberry32(11))).toEqual(mutate(g, KNOBS, 0.3, mulberry32(11)));
  });
});

describe('crossover', () => {
  it('takes each gene from one parent or the other, always in bounds', () => {
    const a = randomGenome(KNOBS, mulberry32(10));
    const b = randomGenome(KNOBS, mulberry32(20));
    const child = crossover(a, b, KNOBS, mulberry32(30));
    expect(child).toHaveLength(KNOBS.length);
    child.forEach((v, i) => {
      expect(v === a[i] || v === b[i]).toBe(true);
    });
    expect(inBounds(child, KNOBS)).toBe(true);
  });

  it('is deterministic for the same seeded rng', () => {
    const a = randomGenome(KNOBS, mulberry32(10));
    const b = randomGenome(KNOBS, mulberry32(20));
    expect(crossover(a, b, KNOBS, mulberry32(4))).toEqual(crossover(a, b, KNOBS, mulberry32(4)));
  });
});

describe('genomeToPatches', () => {
  it('maps each knob to a clamped patch on the given node', () => {
    const g = randomGenome(KNOBS, mulberry32(2));
    const patches = genomeToPatches(g, KNOBS, 'sampler-1');
    expect(patches).toHaveLength(KNOBS.length);
    patches.forEach((p, i) => {
      expect(p.nodeId).toBe('sampler-1');
      expect(p.param).toBe(KNOBS[i].param);
      expect(p.value).toBe(clampKnob(g[i], KNOBS[i]));
    });
  });

  it('clamps + rounds out-of-range genes so patches are always safe to apply', () => {
    const patches = genomeToPatches([999, 999, 9_999_999], KNOBS, 'n'); // [cfg, steps, seed]
    const byParam = Object.fromEntries(patches.map((p) => [p.param, p.value]));
    expect(byParam.cfg).toBe(16); // SD1.5 cfg max
    expect(byParam.steps).toBe(40);
    expect(byParam.seed).toBe(1_000_000);
    expect(Number.isInteger(byParam.steps)).toBe(true);
  });

  it('routes the img2img strength knob to the imageLoader node, others to the sampler', () => {
    const knobs = buildEvolveKnobs({ family: 'SD1.5', hasInitImage: true });
    const g = randomGenome(knobs, mulberry32(5));
    const patches = genomeToPatches(g, knobs, { sampler: 'S', imageLoader: 'IMG' });
    const strength = patches.find((p) => p.param === 'strength')!;
    expect(strength.nodeId).toBe('IMG');
    expect(patches.filter((p) => p.param !== 'strength').every((p) => p.nodeId === 'S')).toBe(true);
  });

  it('skips a knob whose target node is absent (no img2img node -> no strength patch)', () => {
    const knobs = buildEvolveKnobs({ family: 'SD1.5', hasInitImage: true });
    const g = randomGenome(knobs, mulberry32(6));
    const patches = genomeToPatches(g, knobs, { sampler: 'S' }); // no imageLoader id
    expect(patches.some((p) => p.param === 'strength')).toBe(false);
  });
});

describe('selectTopK', () => {
  it('returns the k highest scores, descending', () => {
    const items = [{ score: 1 }, { score: 3 }, { score: 2 }];
    expect(selectTopK(items, 2).map((x) => x.score)).toEqual([3, 2]);
  });

  it('is stable for equal scores (original order preserved)', () => {
    const items = [{ id: 'a', score: 1 }, { id: 'b', score: 1 }, { id: 'c', score: 5 }];
    expect(selectTopK(items, 3).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('clamps k to [0, length]', () => {
    const items = [{ score: 1 }, { score: 2 }];
    expect(selectTopK(items, 99)).toHaveLength(2);
    expect(selectTopK(items, -1)).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const items = [{ score: 1 }, { score: 3 }];
    const before = [...items];
    selectTopK(items, 1);
    expect(items).toEqual(before);
  });
});

describe('renormalizeWeights', () => {
  it('normalizes to sum 1 when CLIP is available', () => {
    const w = renormalizeWeights({ clip: 3, aesthetic: 1 }, true);
    expect(w.clip).toBeCloseTo(0.75, 6);
    expect(w.aesthetic).toBeCloseTo(0.25, 6);
  });

  it('zeroes the CLIP weight when CLIP is unavailable (all aesthetic)', () => {
    expect(renormalizeWeights({ clip: 0.9, aesthetic: 0.1 }, false)).toEqual({ clip: 0, aesthetic: 1 });
  });

  it('falls back sanely when both weights are non-positive', () => {
    expect(renormalizeWeights({ clip: 0, aesthetic: 0 }, true)).toEqual({ clip: 0.5, aesthetic: 0.5 });
    expect(renormalizeWeights({ clip: 0, aesthetic: 0 }, false)).toEqual({ clip: 0, aesthetic: 1 });
    expect(renormalizeWeights({ clip: -2, aesthetic: -1 }, true)).toEqual({ clip: 0.5, aesthetic: 0.5 });
  });
});

// ===========================================================================
// HttpAdapter.evolveStep — result mapping + loud errors
// ===========================================================================
describe('HttpAdapter.evolveStep', () => {
  afterEach(() => vi.unstubAllGlobals());

  const jobsOf = (): RenderJob[] => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const knobs = buildEvolveKnobs('SD1.5');
    const genomes = [randomGenome(knobs, mulberry32(1)), randomGenome(knobs, mulberry32(2))];
    return genomes.map((g) => buildRenderJob(applyPatches(wf, genomeToPatches(g, knobs, sampler.id))));
  };

  it('POSTs /evolve-step and maps image_base64 -> dataUrl + breakdown + index', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { image_base64: 'AAAA', score: 0.8, breakdown: { clip: 0.7, aesthetic: 0.9 }, index: 0 },
            { image_base64: 'BBBB', score: 0.5, breakdown: { clip: null, aesthetic: 0.5 }, index: 1 },
          ],
          clipAvailable: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpAdapter('http://bridge.local');

    const result = await adapter.evolveStep(jobsOf(), {
      prompt: 'a neon cat',
      weights: { clip: 0.6, aesthetic: 0.4 },
      jobId: 'ev1',
    });

    expect(result.clipAvailable).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      dataUrl: 'data:image/png;base64,AAAA',
      score: 0.8,
      index: 0,
      breakdown: { clip: 0.7, aesthetic: 0.9 },
    });
    expect(result.candidates[1].dataUrl).toBe('data:image/png;base64,BBBB');
    expect(result.candidates[1].breakdown.clip).toBeNull();

    // The POST body carries the population jobs + scoring inputs.
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/evolve-step'))!;
    expect(String(call[0])).toBe('http://bridge.local/evolve-step');
    const body = JSON.parse(call[1].body);
    expect(body.prompt).toBe('a neon cat');
    expect(body.weights).toEqual({ clip: 0.6, aesthetic: 0.4 });
    expect(body.jobId).toBe('ev1');
    expect(body.jobs).toHaveLength(2);
  });

  it('passes clipAvailable:false + fallbackReason through (never silent)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ image_base64: 'CCCC', score: 0.42, breakdown: { clip: null, aesthetic: 0.42 }, index: 0 }],
          clipAvailable: false,
          fallbackReason: 'CLIP failed to load; aesthetics only',
        }),
        { status: 200 },
      ),
    ));
    const adapter = new HttpAdapter('http://bridge.local');

    const result = await adapter.evolveStep(jobsOf(), { prompt: 'x', weights: { clip: 1, aesthetic: 0 } });

    expect(result.clipAvailable).toBe(false);
    expect(result.fallbackReason).toMatch(/CLIP failed to load/);
    expect(result.candidates[0].breakdown.clip).toBeNull();
    expect(result.candidates[0].breakdown.aesthetic).toBe(0.42);
  });

  it('throws loudly on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const adapter = new HttpAdapter('http://bridge.local');
    await expect(adapter.evolveStep(jobsOf(), { prompt: 'x', weights: { clip: 1, aesthetic: 1 } }))
      .rejects.toThrow(/\/evolve-step failed \(500\)/);
  });

  it('throws when the candidates array is missing (no silent success)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ clipAvailable: true }), { status: 200 })));
    const adapter = new HttpAdapter('http://bridge.local');
    await expect(adapter.evolveStep(jobsOf(), { prompt: 'x', weights: { clip: 1, aesthetic: 1 } }))
      .rejects.toThrow(/did not include a candidates array/);
  });

  it('throws when a candidate omits image data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ score: 0.5, breakdown: { clip: 0.5, aesthetic: 0.5 }, index: 0 }], clipAvailable: true }), { status: 200 }),
    ));
    const adapter = new HttpAdapter('http://bridge.local');
    await expect(adapter.evolveStep(jobsOf(), { prompt: 'x', weights: { clip: 1, aesthetic: 1 } }))
      .rejects.toThrow(/candidate 0 did not include image data/);
  });
});

// ===========================================================================
// MockAdapter.evolveStep — procedural, clipAvailable:false, never throws
// ===========================================================================
describe('MockAdapter.evolveStep', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Minimal offscreen-canvas stub so the procedural generate() runs in node. */
  const stubCanvas = () => {
    const grad = { addColorStop() {} };
    const ctx = new Proxy({}, { get: () => () => grad, set: () => true });
    const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,MOCK' };
    vi.stubGlobal('document', { createElement: () => canvas });
  };

  const jobsOf = (): RenderJob[] => {
    const wf = createDefaultWorkflow();
    const sampler = findNode(wf, 'sampler')!;
    const knobs = buildEvolveKnobs('SD1.5');
    const genomes = [randomGenome(knobs, mulberry32(1)), randomGenome(knobs, mulberry32(2)), randomGenome(knobs, mulberry32(3))];
    return genomes.map((g) => buildRenderJob(applyPatches(wf, genomeToPatches(g, knobs, sampler.id))));
  };

  it('returns clipAvailable:false with a placeholder note and one candidate per job (never throws)', async () => {
    stubCanvas();
    const jobs = jobsOf();
    const result = await new MockAdapter().evolveStep(jobs, { prompt: 'neon', weights: { clip: 0.5, aesthetic: 0.5 } });

    expect(result.clipAvailable).toBe(false);
    expect(result.fallbackReason).toMatch(/procedural/i);
    expect(result.candidates).toHaveLength(jobs.length);
    result.candidates.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.breakdown.clip).toBeNull();
      expect(c.dataUrl.startsWith('data:')).toBe(true);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
      // With CLIP off, the score is the aesthetic-only value.
      expect(c.score).toBe(c.breakdown.aesthetic);
    });
  });

  it('scores deterministically for the same population', async () => {
    stubCanvas();
    const jobs = jobsOf();
    const a = await new MockAdapter().evolveStep(jobs, { prompt: 'neon', weights: { clip: 0.5, aesthetic: 0.5 } });
    const b = await new MockAdapter().evolveStep(jobs, { prompt: 'neon', weights: { clip: 0.5, aesthetic: 0.5 } });
    expect(a.candidates.map((c) => c.score)).toEqual(b.candidates.map((c) => c.score));
  });
});

// ===========================================================================
// manifest — optional evolve fields (additive)
// ===========================================================================
describe('buildManifest evolve fields', () => {
  it('omits `evolve` for an ordinary render (backward compatible)', () => {
    const m = buildManifest(createDefaultWorkflow(), DEMO_SHELF, '0.16.0', new Date());
    expect(m.evolve).toBeUndefined();
  });

  it('records the evolve settings + winning score when a descriptor is passed', () => {
    const wf = createDefaultWorkflow();
    const m = buildManifest(wf, DEMO_SHELF, '0.17.0', new Date('2026-07-06T00:00:00Z'), [], undefined, {
      generations: 3,
      population: 4,
      weights: { clip: 0.6, aesthetic: 0.4 },
      score: 0.87,
    });
    expect(m.evolve).toEqual({ generations: 3, population: 4, weights: { clip: 0.6, aesthetic: 0.4 }, score: 0.87 });
    // The base workflow is still captured (the adopted params live in graph).
    expect(m.graph).toBe(wf);
    // motion + evolve are independent optional fields.
    expect(m.motion).toBeUndefined();
  });
});
