import { describe, expect, it } from 'vitest';
import { tokenizePrompt, analyzeCraft, MIN_CORPUS, MIN_KEPT } from '../src/core/creative/craftBrain';
import type { RenderInfo } from '../src/core/creative/context';
import type { CreativeRecipe } from '../src/core/creative/types';

describe('tokenizePrompt', () => {
  it('splits on commas into normalized phrase tokens', () => {
    expect(tokenizePrompt('Neon Glow, Cyberpunk City, rain')).toEqual(['neon glow', 'cyberpunk city', 'rain']);
  });
  it('strips weight syntax and enclosing parens/brackets', () => {
    expect(tokenizePrompt('(masterpiece:1.3), [best quality], (soft light)')).toEqual(['masterpiece', 'best quality', 'soft light']);
  });
  it('drops standalone stopwords and sub-2-char fragments', () => {
    expect(tokenizePrompt('the, a, of, x, portrait')).toEqual(['portrait']);
  });
  it('returns [] for blank or punctuation-only prompts', () => {
    expect(tokenizePrompt('')).toEqual([]);
    expect(tokenizePrompt('  ,  , ')).toEqual([]);
  });
  it('drops punctuation-only +/- segments (no junk chips)', () => {
    expect(tokenizePrompt('masterpiece, --, detailed')).toEqual(['masterpiece', 'detailed']);
    expect(tokenizePrompt('++, -')).toEqual([]);
  });
});

function mk(id: number, prompt: string, kept: boolean, over: Partial<RenderInfo> = {}): RenderInfo {
  return {
    id: `r${id}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    aspect: '1:1',
    labeled: kept,
    signature: `${prompt}|0|512x512`,
    prompt,
    linkedToProject: kept,
    modelFamily: 'Pony',
    sampler: 'euler_a',
    steps: 20,
    cfg: 4,
    negativePrompt: '',
    fallback: false,
    kept,
    ...over,
  };
}

// A corpus large enough to be "ready": 30 renders, 12 kept. In the kept set the tokens
// 'neon glow' and 'rain' appear far more often than in the corpus at large (positive
// lift) and co-occur; 'city' is universal (lift 1.0 -> excluded, it's the baseline).
function readyCorpus(): RenderInfo[] {
  const rs: RenderInfo[] = [];
  for (let i = 0; i < 12; i++) rs.push(mk(i, i < 10 ? 'neon glow, rain, city' : 'city', true)); // kept: 10/12 have the pattern
  for (let i = 12; i < 30; i++) rs.push(mk(i, i < 14 ? 'neon glow, rain, city' : 'city', false)); // unkept: 2/18 have the pattern
  return rs;
}

describe('analyzeCraft — gating', () => {
  it('is not ready and hides working/suggestions under the data threshold', () => {
    const rep = analyzeCraft([mk(1, 'neon glow', true), mk(2, 'city', true)], [], new Date());
    expect(rep.ready).toBe(false);
    expect(rep.working).toEqual([]);
    expect(rep.suggestions).toEqual([]);
    // palette is descriptive and always safe
    expect(rep.palette.some((p) => p.label === 'neon glow')).toBe(true);
    expect(rep.totals.corpus).toBe(2);
  });

  it('MIN_CORPUS/MIN_KEPT are the documented thresholds', () => {
    expect(MIN_CORPUS).toBe(24);
    expect(MIN_KEPT).toBe(8);
  });
});

describe('analyzeCraft — what works', () => {
  it('surfaces a high-lift token from the kept set with a confidence tier', () => {
    const rep = analyzeCraft(readyCorpus(), [], new Date());
    expect(rep.ready).toBe(true);
    const neon = rep.working.find((w) => w.kind === 'token' && w.label === 'neon glow');
    expect(neon).toBeTruthy();
    expect(neon!.lift).toBeGreaterThan(1.15);
    expect(neon!.keptCount).toBe(10);
    expect(['high', 'medium', 'low']).toContain(neon!.confidence);
  });

  it('excludes fallback renders from the corpus', () => {
    const rs = readyCorpus().concat(Array.from({ length: 5 }, (_, i) => mk(100 + i, 'garbage token', false, { fallback: true })));
    const rep = analyzeCraft(rs, [], new Date());
    expect(rep.palette.some((p) => p.label === 'garbage token')).toBe(false);
  });

  it('suggests a recipe from co-occurring high-lift tokens, but not one already covered by a recipe', () => {
    const none = analyzeCraft(readyCorpus(), [], new Date());
    // 'neon glow' + 'rain' both lift and co-occur across the kept set -> one suggestion
    expect(none.suggestions.length).toBeGreaterThanOrEqual(1);
    expect([...none.suggestions[0].tokens].sort()).toEqual(['neon glow', 'rain']);
    // once a recipe already covers that exact token set, the suggestion is dropped
    const covered: CreativeRecipe = { id: 'x', name: 'n', promptTemplate: 'rain, neon glow', negativePrompt: '' } as CreativeRecipe;
    const withRecipe = analyzeCraft(readyCorpus(), [covered], new Date());
    expect(withRecipe.suggestions.every((s) => !(s.tokens.includes('neon glow') && s.tokens.includes('rain')))).toBe(true);
    expect(withRecipe.suggestions.length).toBe(none.suggestions.length - 1);
  });

  it('ranks high-confidence findings above small-sample saturated-lift ones', () => {
    // 24 renders, 8 kept. 'staple' is well-supported (6 kept / 8 all -> lift 2.25, high);
    // 'niche' is a 3-only-kept artifact (3/3 -> lift 3.0, but low confidence).
    const rs: RenderInfo[] = [];
    let id = 0;
    for (let i = 0; i < 3; i++) rs.push(mk(id++, 'staple, niche', true));
    for (let i = 0; i < 3; i++) rs.push(mk(id++, 'staple', true));
    for (let i = 0; i < 2; i++) rs.push(mk(id++, 'filler', true));
    for (let i = 0; i < 2; i++) rs.push(mk(id++, 'staple', false));
    for (let i = 0; i < 14; i++) rs.push(mk(id++, 'city', false));
    const rep = analyzeCraft(rs, [], new Date());
    expect(rep.ready).toBe(true);
    const staple = rep.working.find((w) => w.label === 'staple')!;
    const niche = rep.working.find((w) => w.label === 'niche')!;
    expect(staple?.confidence).toBe('high');
    expect(niche?.confidence).toBe('low');
    expect(niche.lift).toBeGreaterThan(staple.lift); // niche has the bigger raw multiplier...
    const iStaple = rep.working.findIndex((w) => w.label === 'staple');
    const iNiche = rep.working.findIndex((w) => w.label === 'niche');
    expect(iStaple).toBeLessThan(iNiche); // ...but the well-supported one ranks first
  });

  it('fills MAX_SUGGESTIONS with fresh clusters even when a recipe covers an early cluster', () => {
    // four disjoint co-occurring pairs; a recipe covers the first ('a1, a2').
    const rs: RenderInfo[] = [];
    let id = 0;
    const pairs = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2']];
    for (const [x, y] of pairs) for (let i = 0; i < 3; i++) rs.push(mk(id++, `${x}, ${y}`, true)); // 12 kept
    for (let i = 0; i < 12; i++) rs.push(mk(id++, 'city', false)); // 12 unkept -> corpus 24
    const recipe: CreativeRecipe = { id: 'r', name: 'n', promptTemplate: 'a1, a2', negativePrompt: '' } as CreativeRecipe;
    const rep = analyzeCraft(rs, [recipe], new Date());
    expect(rep.ready).toBe(true);
    // the 'a' cluster is recipe-covered, but the cap applies AFTER dedup, so 3 fresh land
    expect(rep.suggestions.length).toBe(3);
    expect(rep.suggestions.some((s) => s.tokens.includes('a1'))).toBe(false);
    expect(rep.suggestions.some((s) => s.tokens.includes('d1') && s.tokens.includes('d2'))).toBe(true);
  });
});
