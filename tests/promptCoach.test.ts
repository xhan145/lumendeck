import { describe, expect, it } from 'vitest';
import { coach, appendTokens, MAX_TOKEN_SUGGESTIONS, COACH_SIM } from '../src/core/creative/promptCoach';
import type { CraftReport, CraftInsight } from '../src/core/creative/craftBrain';
import type { PromptLineage } from '../src/core/creative/promptLineage';
import type { CreativeRecipe } from '../src/core/creative/types';

function tok(label: string, lift = 2, kind: CraftInsight['kind'] = 'token'): CraftInsight {
  return { kind, label, keptCount: 5, allCount: 6, lift, confidence: 'high' };
}
function report(working: CraftInsight[]): CraftReport {
  return { ready: true, totals: { corpus: 30, kept: 10 }, palette: [], settings: { model: [], sampler: [], cfg: [], steps: [], aspect: [] }, working, suggestions: [] };
}
function line(spine: string[]): PromptLineage {
  return { id: spine.join(), renderIds: ['a', 'b'], spine, steps: [], size: 2 };
}
function recipe(id: string, name: string, promptTemplate: string): CreativeRecipe {
  return { id, name, promptTemplate, negativePrompt: '' } as CreativeRecipe;
}

describe('appendTokens', () => {
  it('appends comma-joined to a non-blank prompt and trims', () => {
    expect(appendTokens('neon glow', ['city', 'rain'])).toBe('neon glow, city, rain');
    expect(appendTokens('  neon glow  ', ['city'])).toBe('neon glow, city');
  });
  it('seeds a blank prompt and no-ops on empty tokens', () => {
    expect(appendTokens('', ['city'])).toBe('city');
    expect(appendTokens('neon glow', [])).toBe('neon glow');
  });
});

describe('coach', () => {
  it('suggests high-lift tokens not already present, excludes non-token insights, caps the count', () => {
    const working = [tok('neon glow', 2.5), tok('city', 2.1), tok('Pony', 3, 'model'), ...Array.from({ length: 8 }, (_, i) => tok(`t${i}`, 1.5))];
    const out = coach('city', report(working), [], []);
    const tokens = out.filter((s) => s.kind === 'add-token');
    expect(tokens.length).toBe(MAX_TOKEN_SUGGESTIONS);
    expect(tokens.some((s) => s.label === 'city')).toBe(false); // already present
    expect(tokens.some((s) => s.label === 'Pony')).toBe(false); // not a token insight
    expect(tokens[0].label).toBe('neon glow'); // lift order preserved
    expect(tokens[0].tokens).toEqual(['neon glow']);
  });

  it('resembles-a-line: best spine >= COACH_SIM, lists only missing tokens', () => {
    const out = coach('neon glow, city', report([]), [line(['neon glow', 'city', 'rain'])], []);
    const ln = out.find((s) => s.kind === 'apply-line')!;
    expect(ln).toBeTruthy();
    expect(ln.tokens).toEqual(['rain']); // only the missing spine token
    expect(COACH_SIM).toBe(0.3);
  });

  it('does not suggest a line when the current prompt already covers the whole spine', () => {
    const out = coach('neon glow, city, rain', report([]), [line(['neon glow', 'city', 'rain'])], []);
    expect(out.some((s) => s.kind === 'apply-line')).toBe(false);
  });

  it('apply-recipe: best overlapping recipe, sets recipeId', () => {
    const out = coach('neon glow', report([]), [], [recipe('r1', 'Neon Nights', 'neon glow, city')]);
    const rc = out.find((s) => s.kind === 'apply-recipe')!;
    expect(rc).toBeTruthy();
    expect(rc.recipeId).toBe('r1');
    expect(rc.label).toBe('Neon Nights');
  });

  it('each source self-gates; empty everything -> []; determinism', () => {
    expect(coach('', report([]), [], [])).toEqual([]);
    // add-token silent when working is empty, but a line still fires on its own signal:
    const withLine = coach('neon glow', report([]), [line(['neon glow', 'city'])], []);
    expect(withLine.some((s) => s.kind === 'apply-line')).toBe(true);
    const a = coach('neon glow', report([tok('rim light')]), [line(['neon glow', 'city'])], [recipe('r', 'R', 'neon glow, city')]);
    const b = coach('neon glow', report([tok('rim light')]), [line(['neon glow', 'city'])], [recipe('r', 'R', 'neon glow, city')]);
    expect(a).toEqual(b);
  });
});
