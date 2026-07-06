import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRenderJob } from '../src/bridge/adapter';
import { buildManifest } from '../src/core/manifest';
import {
  deletePreset,
  restorePreset,
  savePreset,
  seedStarterPresets,
  STARTER_PRESETS,
  visiblePresets,
  type PromptPreset,
} from '../src/core/prompt/presets';
import {
  BUILTIN_WILDCARDS,
  expandWildcards,
  hasWildcards,
  mulberry32,
  seedBuiltinWildcards,
  type WildcardSet,
} from '../src/core/prompt/wildcards';
import { planVariations, CFG_MIN, CFG_MAX, STEPS_MIN, STEPS_MAX } from '../src/core/prompt/variations';
import { record, search, toggleFavorite, type PromptHistoryEntry } from '../src/core/prompt/history';
import { detectSubject, enhancePrompt, mergeNegatives, normalizeWeight, HeuristicAssistant } from '../src/core/prompt/enhance';
import { hydratePromptTools } from '../src/state/promptTools';
import { createDefaultWorkflow, findNode, updateNodeParam } from '../src/core/workflow';
import { DEMO_SHELF } from '../src/data/demoShelf';
import { mockAdapter, useStudio } from '../src/state/store';
import { sanitizeBackendSettings } from '../src/turboForge/backends/backendSettings';

// ---------------------------------------------------------------------------
// wildcards.expandWildcards
// ---------------------------------------------------------------------------
describe('expandWildcards', () => {
  const sets: WildcardSet[] = [
    { name: 'color', values: ['red', 'green', 'blue'] },
    { name: 'lighting', values: ['soft', 'harsh'] },
  ];

  it('is deterministic: same seed -> same resolution', () => {
    const a = expandWildcards('a __color__ car, __lighting__ light', sets, mulberry32(42));
    const b = expandWildcards('a __color__ car, __lighting__ light', sets, mulberry32(42));
    expect(a.resolved).toBe(b.resolved);
    expect(a.used).toEqual(b.used);
  });

  it('different seeds can produce different resolutions', () => {
    const results = new Set<string>();
    for (let s = 0; s < 20; s++) {
      results.add(expandWildcards('__color__', sets, mulberry32(s)).resolved);
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('replaces known tokens and reports which were used', () => {
    const r = expandWildcards('__color__ and __color__', sets, mulberry32(7));
    expect(r.resolved).not.toContain('__color__');
    expect(r.used).toHaveLength(2);
    expect(r.used.every((u) => u.token === 'color')).toBe(true);
    expect(r.unknown).toEqual([]);
  });

  it('passes unknown tokens through untouched and reports them', () => {
    const r = expandWildcards('a __color__ __nope__ __also_missing__', sets, mulberry32(1));
    expect(r.resolved).toContain('__nope__');
    expect(r.resolved).toContain('__also_missing__');
    expect(r.unknown).toEqual(['nope', 'also_missing']);
  });

  it('treats an empty value set as unknown (passthrough)', () => {
    const r = expandWildcards('__empty__', [{ name: 'empty', values: [] }], mulberry32(1));
    expect(r.resolved).toBe('__empty__');
    expect(r.unknown).toEqual(['empty']);
  });

  it('resolves nested tokens exactly one pass (documented limit)', () => {
    const nested: WildcardSet[] = [
      { name: 'outer', values: ['a __inner__ b'] },
      { name: 'inner', values: ['MID __deep__'] },
      { name: 'deep', values: ['DEEP'] },
    ];
    const r = expandWildcards('__outer__', nested, mulberry32(3));
    // one nested pass resolves __inner__, but __deep__ inside it stays literal.
    expect(r.resolved).toBe('a MID __deep__ b');
  });

  it('hasWildcards detects tokens', () => {
    expect(hasWildcards('plain text')).toBe(false);
    expect(hasWildcards('a __color__ thing')).toBe(true);
  });

  it('seedBuiltinWildcards returns a deep copy of all builtin sets', () => {
    const seeded = seedBuiltinWildcards();
    expect(seeded.map((s) => s.name)).toEqual(BUILTIN_WILDCARDS.map((s) => s.name));
    seeded[0].values.push('mutant');
    expect(BUILTIN_WILDCARDS[0].values).not.toContain('mutant');
  });
});

// ---------------------------------------------------------------------------
// presets CRUD + seeding + builtin-hide
// ---------------------------------------------------------------------------
describe('presets', () => {
  const userPreset: PromptPreset = {
    id: 'user-1', name: 'Mine', positive: 'p', negative: 'n', createdAt: '2026-07-06T00:00:00Z',
  };

  it('ships ~10 curated builtin starters, all flagged builtin', () => {
    expect(STARTER_PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(STARTER_PRESETS.every((p) => p.builtin)).toBe(true);
  });

  it('seedStarterPresets returns a deep copy', () => {
    const seeded = seedStarterPresets();
    expect(seeded).toHaveLength(STARTER_PRESETS.length);
    seeded[0].name = 'changed';
    expect(STARTER_PRESETS[0].name).not.toBe('changed');
  });

  it('savePreset appends a new preset and updates an existing one in place', () => {
    const list = seedStarterPresets();
    const withUser = savePreset(list, userPreset);
    expect(withUser).toHaveLength(list.length + 1);

    const renamed = savePreset(withUser, { ...userPreset, name: 'Renamed' });
    expect(renamed).toHaveLength(withUser.length);
    expect(renamed.find((p) => p.id === 'user-1')?.name).toBe('Renamed');
  });

  it('deleting a builtin HIDES it (restorable), not removed', () => {
    const list = seedStarterPresets();
    const id = list[0].id;
    const after = deletePreset(list, id);
    expect(after).toHaveLength(list.length); // still present
    expect(after.find((p) => p.id === id)?.hidden).toBe(true);
    expect(visiblePresets(after).find((p) => p.id === id)).toBeUndefined();

    const restored = restorePreset(after, id);
    expect(visiblePresets(restored).find((p) => p.id === id)).toBeDefined();
  });

  it('deleting a user preset removes it outright', () => {
    const list = savePreset(seedStarterPresets(), userPreset);
    const after = deletePreset(list, 'user-1');
    expect(after.find((p) => p.id === 'user-1')).toBeUndefined();
    expect(after).toHaveLength(list.length - 1);
  });
});

// ---------------------------------------------------------------------------
// variations.planVariations
// ---------------------------------------------------------------------------
describe('planVariations', () => {
  const base = { seed: 1000, cfg: 7, steps: 28 };

  it('seed axis: distinct incrementing seeds, correct count', () => {
    const plan = planVariations({ base, axis: 'seed', count: 4 });
    expect(plan).toHaveLength(4);
    expect(plan.map((p) => p.seed)).toEqual([1000, 1001, 1002, 1003]);
    expect(plan.every((p) => p.cfg === undefined && p.steps === undefined)).toBe(true);
  });

  it('cfg axis: sweeps within [CFG_MIN, CFG_MAX]', () => {
    const plan = planVariations({ base, axis: 'cfg', count: 5 });
    expect(plan).toHaveLength(5);
    const cfgs = plan.map((p) => p.cfg!);
    expect(cfgs[0]).toBe(CFG_MIN);
    expect(cfgs[cfgs.length - 1]).toBe(CFG_MAX);
    expect(Math.min(...cfgs)).toBeGreaterThanOrEqual(CFG_MIN);
    expect(Math.max(...cfgs)).toBeLessThanOrEqual(CFG_MAX);
  });

  it('steps axis: sweeps within [STEPS_MIN, STEPS_MAX] as whole numbers', () => {
    const plan = planVariations({ base, axis: 'steps', count: 5 });
    expect(plan[0].steps).toBe(STEPS_MIN);
    expect(plan[plan.length - 1].steps).toBe(STEPS_MAX);
    expect(plan.every((p) => Number.isInteger(p.steps!))).toBe(true);
  });

  it('wildcard axis: one distinct value per variation (cycled) with advancing seed', () => {
    const plan = planVariations({ base, axis: 'wildcard', count: 3, wildcardValues: ['x', 'y'] });
    expect(plan.map((p) => p.wildcardValue)).toEqual(['x', 'y', 'x']);
    expect(plan.map((p) => p.seed)).toEqual([1000, 1001, 1002]);
  });

  it('clamps count to 1..16', () => {
    expect(planVariations({ base, axis: 'seed', count: 0 })).toHaveLength(1);
    expect(planVariations({ base, axis: 'seed', count: 99 })).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// history.record / search / toggleFavorite
// ---------------------------------------------------------------------------
describe('prompt history', () => {
  const mk = (over: Partial<PromptHistoryEntry> = {}): PromptHistoryEntry => ({
    id: Math.random().toString(36).slice(2),
    positive: 'a cat',
    negative: 'blurry',
    seed: 1,
    at: '2026-07-06T00:00:00Z',
    favorite: false,
    ...over,
  });

  it('dedups consecutive identical prompts', () => {
    let list: PromptHistoryEntry[] = [];
    list = record(list, mk({ id: 'a', positive: 'x', seed: 5 }));
    list = record(list, mk({ id: 'b', positive: 'x', seed: 5 }));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('a');
    // a different seed is NOT a dup
    list = record(list, mk({ id: 'c', positive: 'x', seed: 6 }));
    expect(list).toHaveLength(2);
  });

  it('trims to cap but keeps ALL favorites', () => {
    let list: PromptHistoryEntry[] = [];
    // seed a couple of favorites first (oldest)
    list = record(list, mk({ id: 'fav1', positive: 'p0', favorite: true }), 5);
    list = record(list, mk({ id: 'fav2', positive: 'p1', favorite: true }), 5);
    // then push many non-favorites past the cap
    for (let i = 0; i < 20; i++) {
      list = record(list, mk({ id: `n${i}`, positive: `non-${i}` }), 5);
    }
    expect(list.length).toBe(5);
    expect(list.filter((e) => e.favorite).map((e) => e.id).sort()).toEqual(['fav1', 'fav2']);
  });

  it('keeps every favorite even when favorites exceed the cap', () => {
    let list: PromptHistoryEntry[] = [];
    for (let i = 0; i < 6; i++) {
      list = record(list, mk({ id: `f${i}`, positive: `fav-${i}`, favorite: true }), 3);
    }
    expect(list).toHaveLength(6);
  });

  it('toggleFavorite flips the flag', () => {
    let list = [mk({ id: 'x', favorite: false })];
    list = toggleFavorite(list, 'x');
    expect(list[0].favorite).toBe(true);
    list = toggleFavorite(list, 'x');
    expect(list[0].favorite).toBe(false);
  });

  it('search matches positive/negative/resolved substrings (case-insensitive)', () => {
    const list = [
      mk({ id: '1', positive: 'a Neon City', negative: 'x' }),
      mk({ id: '2', positive: 'plain', negative: 'contains NEON too' }),
      mk({ id: '3', positive: 'p', negative: 'n', resolved: 'resolved neon glow' }),
      mk({ id: '4', positive: 'nothing here' }),
    ];
    expect(search(list, 'neon').map((e) => e.id).sort()).toEqual(['1', '2', '3']);
    expect(search(list, '')).toHaveLength(4);
  });

  it('search supports onlyFavorites and favoritesFirst ordering', () => {
    const list = [
      mk({ id: '1', positive: 'neon a', favorite: false }),
      mk({ id: '2', positive: 'neon b', favorite: true }),
    ];
    expect(search(list, 'neon', { onlyFavorites: true }).map((e) => e.id)).toEqual(['2']);
    expect(search(list, 'neon', { favoritesFirst: true }).map((e) => e.id)).toEqual(['2', '1']);
  });
});

// ---------------------------------------------------------------------------
// enhance
// ---------------------------------------------------------------------------
describe('enhancePrompt', () => {
  it('detects subject from the text', () => {
    expect(detectSubject('a portrait of a woman')).toBe('portrait');
    expect(detectSubject('a mountain landscape at sunset')).toBe('landscape');
    expect(detectSubject('an abstract shape')).toBe('generic');
  });

  it('adds portrait-specific tags for a portrait prompt', () => {
    const r = enhancePrompt('portrait of a woman');
    expect(r.positive).toContain('detailed skin texture');
    expect(r.positive).toContain('catchlight in eyes');
  });

  it('adds landscape-specific tags for a landscape prompt', () => {
    const r = enhancePrompt('a vast mountain valley');
    expect(r.positive).toContain('atmospheric depth');
  });

  it('proposes standard negatives', () => {
    const r = enhancePrompt('a cat');
    expect(r.negativeAdditions).toContain('blurry');
    expect(r.negativeAdditions).toContain('extra fingers');
  });

  it('is idempotent: running twice adds nothing new', () => {
    const once = enhancePrompt('portrait of a man');
    const twice = enhancePrompt(once.positive);
    expect(twice.positive).toBe(once.positive);
  });

  it('normalizes weight syntax', () => {
    expect(normalizeWeight('(glow : 1.20)')).toBe('(glow:1.2)');
    expect(normalizeWeight('(dark:1.0)')).toBe('(dark:1)');
    expect(normalizeWeight('plain')).toBe('plain');
  });

  it('de-dups existing tags (weight-normalized)', () => {
    const r = enhancePrompt('cat, cat, (glow : 1.2), (glow:1.2)');
    const tags = r.positive.split(',').map((t) => t.trim());
    expect(tags.filter((t) => t === 'cat')).toHaveLength(1);
    expect(tags.filter((t) => t === '(glow:1.2)')).toHaveLength(1);
  });

  it('mergeNegatives appends without duplicating', () => {
    expect(mergeNegatives('blurry, lowres', ['blurry', 'watermark'])).toBe('blurry, lowres, watermark');
  });

  it('HeuristicAssistant.enhance returns the same result as the pure fn', async () => {
    const assistant = new HeuristicAssistant();
    expect(assistant.available).toBe(true);
    const viaAssistant = await assistant.enhance('a cat');
    expect(viaAssistant.positive).toBe(enhancePrompt('a cat').positive);
  });
});

// ---------------------------------------------------------------------------
// buildRenderJob wildcard resolution + manifest fields
// ---------------------------------------------------------------------------
describe('buildRenderJob + manifest wildcard integration', () => {
  const sets: WildcardSet[] = [
    { name: 'style', values: ['cinematic', 'anime'] },
    { name: 'lighting', values: ['soft', 'harsh'] },
  ];

  function wfWithPrompt(positive: string, seed = 1234) {
    let wf = createDefaultWorkflow();
    wf = updateNodeParam(wf, findNode(wf, 'prompt')!.id, 'positive', positive);
    wf = updateNodeParam(wf, findNode(wf, 'sampler')!.id, 'seed', seed);
    return wf;
  }

  it('resolves wildcards into the job prompt and records usedWildcards', () => {
    const wf = wfWithPrompt('a __style__ shot, __lighting__ light', 42);
    const job = buildRenderJob(wf, sets);
    expect(job.prompt).not.toContain('__style__');
    expect(job.resolvedPrompt).toBe(job.prompt);
    expect(job.usedWildcards.map((w) => w.token).sort()).toEqual(['lighting', 'style']);
  });

  it('is a no-op when there are no wildcard tokens (resolved === original)', () => {
    const wf = wfWithPrompt('a plain cat with no tokens', 42);
    const job = buildRenderJob(wf, sets);
    expect(job.resolvedPrompt).toBe('a plain cat with no tokens');
    expect(job.prompt).toBe('a plain cat with no tokens');
    expect(job.usedWildcards).toEqual([]);
  });

  it('re-rendering with the same fixed seed resolves identically', () => {
    const wf = wfWithPrompt('a __style__ scene', 777);
    const a = buildRenderJob(wf, sets);
    const b = buildRenderJob(wf, sets);
    expect(a.resolvedPrompt).toBe(b.resolvedPrompt);
  });

  it('manifest records resolvedPrompt + wildcards', () => {
    const wf = wfWithPrompt('a __style__ portrait', 999);
    const m = buildManifest(wf, DEMO_SHELF, '0.1.0', new Date('2026-07-06T00:00:00Z'), sets);
    expect(m.prompt).toBe('a __style__ portrait');
    expect(m.resolvedPrompt).not.toContain('__style__');
    expect(m.wildcards.map((w) => w.token)).toEqual(['style']);
  });

  it('manifest resolvedPrompt equals prompt when no tokens present', () => {
    const wf = wfWithPrompt('no tokens here', 5);
    const m = buildManifest(wf, DEMO_SHELF, '0.1.0', new Date(), sets);
    expect(m.resolvedPrompt).toBe('no tokens here');
    expect(m.wildcards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hydratePromptTools (persist migration)
// ---------------------------------------------------------------------------
describe('hydratePromptTools', () => {
  it('returns seeded defaults when nothing is persisted', () => {
    const state = hydratePromptTools(undefined);
    expect(state.presets.length).toBeGreaterThanOrEqual(10);
    expect(state.wildcardSets.length).toBe(BUILTIN_WILDCARDS.length);
    expect(state.history).toEqual([]);
  });

  it('preserves persisted content and re-adds missing new builtins', () => {
    const state = hydratePromptTools({
      presets: [{ id: 'user-x', name: 'X', positive: 'p', negative: 'n', createdAt: 'now' }],
      wildcardSets: [{ name: 'custom', values: ['a'] }],
      history: [],
    });
    expect(state.presets.find((p) => p.id === 'user-x')).toBeDefined();
    // starter builtins get re-added
    expect(state.presets.length).toBeGreaterThan(1);
    expect(state.wildcardSets.find((s) => s.name === 'custom')).toBeDefined();
    expect(state.wildcardSets.find((s) => s.name === 'color')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// store actions: applyPreset writes capsules + recordHistory on enqueue
// ---------------------------------------------------------------------------
describe('store prompt-tools actions', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
    useStudio.setState({ promptTools: hydratePromptTools(undefined) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applyPreset writes positive/negative + sampler settings into the capsules', () => {
    const preset: PromptPreset = {
      id: 'p-apply', name: 'Apply Test', positive: 'a shiny robot', negative: 'ugly',
      settings: { steps: 33, cfg: 8.5, sampler: 'ddim', scheduler: 'exponential' },
      createdAt: 'now',
    };
    useStudio.getState().savePreset(preset);
    useStudio.getState().applyPreset('p-apply');

    const wf = useStudio.getState().workflow;
    const prompt = findNode(wf, 'prompt')!;
    const sampler = findNode(wf, 'sampler')!;
    expect(prompt.params.positive).toBe('a shiny robot');
    expect(prompt.params.negative).toBe('ugly');
    expect(sampler.params.steps).toBe(33);
    expect(sampler.params.cfg).toBe(8.5);
    expect(sampler.params.sampler).toBe('ddim');
    expect(sampler.params.scheduler).toBe('exponential');
  });

  it('deletePreset hides a builtin via the store', () => {
    const builtinId = useStudio.getState().promptTools.presets.find((p) => p.builtin)!.id;
    useStudio.getState().deletePreset(builtinId);
    const preset = useStudio.getState().promptTools.presets.find((p) => p.id === builtinId)!;
    expect(preset.hidden).toBe(true);
  });

  it('upsert/deleteWildcardSet manage the slice', () => {
    useStudio.getState().upsertWildcardSet({ name: 'weather', values: ['rain', 'sun'] });
    expect(useStudio.getState().promptTools.wildcardSets.find((s) => s.name === 'weather')).toBeDefined();
    useStudio.getState().upsertWildcardSet({ name: 'weather', values: ['rain', 'sun', 'snow'] });
    expect(useStudio.getState().promptTools.wildcardSets.find((s) => s.name === 'weather')!.values).toHaveLength(3);
    useStudio.getState().deleteWildcardSet('weather');
    expect(useStudio.getState().promptTools.wildcardSets.find((s) => s.name === 'weather')).toBeUndefined();
  });

  it('recordHistory + toggleFavorite + loadHistoryEntry round-trip', () => {
    useStudio.getState().recordHistory({
      id: 'h1', positive: 'loaded prompt', negative: 'neg', seed: 555, at: 'now', favorite: false,
    });
    let entry = useStudio.getState().promptTools.history[0];
    expect(entry.id).toBe('h1');
    useStudio.getState().toggleFavorite('h1');
    entry = useStudio.getState().promptTools.history[0];
    expect(entry.favorite).toBe(true);

    useStudio.getState().loadHistoryEntry('h1');
    const wf = useStudio.getState().workflow;
    expect(findNode(wf, 'prompt')!.params.positive).toBe('loaded prompt');
    expect(findNode(wf, 'sampler')!.params.seed).toBe(555);
  });

  it('enqueueRender records a history entry with the resolved prompt + seed', async () => {
    // mock backend + a valid model so the render succeeds
    const model = findNode(useStudio.getState().workflow, 'model')!;
    useStudio.getState().updateParam(model.id, 'assetId', 'ckpt-lumen-xl');
    const prompt = findNode(useStudio.getState().workflow, 'prompt')!;
    useStudio.getState().updateParam(prompt.id, 'positive', 'a __style__ portrait');
    useStudio.getState().upsertWildcardSet({ name: 'style', values: ['cinematic'] });
    useStudio.setState({
      backendSettings: sanitizeBackendSettings({ selectedBackend: 'mock' }),
      adapterId: 'mock',
      queue: [],
      queuePaused: false,
    });
    // The real mock adapter draws to a <canvas>; stub generate for the node env.
    vi.spyOn(mockAdapter, 'generate').mockResolvedValue({
      dataUrl: 'data:image/png;base64,abc',
      mediaType: 'image',
      mimeType: 'image/png',
      extension: 'png',
      seed: 1337,
    });

    const before = useStudio.getState().promptTools.history.length;
    await useStudio.getState().enqueueRender();
    const after = useStudio.getState().promptTools.history;
    expect(after.length).toBe(before + 1);
    expect(after[0].positive).toBe('a __style__ portrait');
    expect(after[0].resolved).toContain('cinematic');
    expect(after[0].resolved).not.toContain('__style__');
  });
});
