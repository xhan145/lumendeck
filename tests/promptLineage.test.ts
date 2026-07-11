import { describe, expect, it } from 'vitest';
import { buildLineages, diffPrompts, diffSettings, LINEAGE_SIM } from '../src/core/creative/promptLineage';
import type { RenderInfo } from '../src/core/creative/context';

function r(id: number, prompt: string, minsAgo: number, over: Partial<RenderInfo> = {}): RenderInfo {
  return {
    id: `r${id}`,
    createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + (100 - minsAgo) * 60000).toISOString(),
    aspect: '1:1',
    labeled: false,
    signature: `${prompt}|0|512x512`,
    prompt,
    linkedToProject: false,
    modelFamily: 'Pony',
    sampler: 'euler_a',
    steps: 20,
    cfg: 4,
    fallback: false,
    kept: false,
    ...over,
  };
}

describe('diffPrompts', () => {
  it('reports added / removed / kept tokens', () => {
    expect(diffPrompts(['neon glow', 'city', 'rain'], ['neon glow', 'city', 'storm'])).toEqual({
      added: ['storm'], removed: ['rain'], kept: ['neon glow', 'city'],
    });
  });
});

describe('diffSettings', () => {
  it('lists only the changed settings', () => {
    const a = r(1, 'x', 10);
    const b = r(2, 'x', 5, { cfg: 7, steps: 30 });
    const deltas = diffSettings(a, b);
    const keys = deltas.map((d) => d.key).sort();
    expect(keys).toEqual(['cfg', 'steps']);
    expect(deltas.find((d) => d.key === 'cfg')).toEqual({ key: 'cfg', from: '4', to: '7' });
  });
});

describe('buildLineages', () => {
  it('groups a variation with its parent (Jaccard >= threshold) and excludes singletons', () => {
    const rs = [
      r(1, 'neon glow, city, rain', 30),
      r(2, 'neon glow, city, storm', 20), // Jaccard vs r1 = 2/4 = 0.5 -> joins
      r(3, 'portrait, studio light', 10), // unrelated -> its own singleton -> dropped
    ];
    const lineages = buildLineages(rs);
    expect(lineages).toHaveLength(1);
    expect(lineages[0].renderIds).toEqual(['r1', 'r2']); // time-ordered
    expect(lineages[0].size).toBe(2);
    expect(lineages[0].spine).toEqual(['city', 'neon glow']); // intersection, sorted
    expect(lineages[0].steps[0]).toEqual({ renderId: 'r1', added: [], removed: [] });
    expect(lineages[0].steps[1]).toEqual({ renderId: 'r2', added: ['storm'], removed: ['rain'] });
  });

  it('splits prompts below the similarity threshold', () => {
    // 'aa,bb' vs 'aa,cc': inter={aa}=1, union={aa,bb,cc}=3 -> 0.33 < 0.5 -> two singletons -> none survive
    // (tokens must be >= 2 chars — tokenizePrompt drops single-char fragments.)
    const rs = [r(1, 'aa, bb', 20), r(2, 'aa, cc', 10)];
    expect(LINEAGE_SIM).toBe(0.5);
    expect(buildLineages(rs)).toEqual([]);
  });

  it('excludes fallback and empty-prompt renders, and is deterministic + empty-safe', () => {
    expect(buildLineages([])).toEqual([]);
    const rs = [
      r(1, 'neon glow, city', 30),
      r(2, 'neon glow, city', 20, { fallback: true }), // excluded
      r(3, '', 10), // empty -> excluded
    ];
    expect(buildLineages(rs)).toEqual([]); // only one real render -> singleton -> dropped
    // determinism
    const a = buildLineages([r(1, 'neon glow, city, rain', 30), r(2, 'neon glow, city, storm', 20)]);
    const b = buildLineages([r(2, 'neon glow, city, storm', 20), r(1, 'neon glow, city, rain', 30)]);
    expect(a).toEqual(b);
  });
});
