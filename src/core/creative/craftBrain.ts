/**
 * Craft brain: mines the render history (prompt tokens + settings) for signature
 * patterns and what correlates with the renders you kept. Pure + deterministic —
 * `now` is injected, nothing is mutated, never throws on blank input. No ML; frequency
 * + confidence-gated lift only. Mirrors the house style of portfolio.ts.
 */
import type { CreativeRecipe } from './types';
import type { RenderInfo } from './context';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'with', 'in', 'on', 'to', 'by', 'for', 'at',
  'is', 'it', 'this', 'that', 'very', 'highly', 'extremely',
]);

/**
 * Normalize a prompt into phrase tokens: lowercase, split on commas/newlines, strip
 * weight syntax (`(tok:1.2)` -> `tok`) and enclosing brackets, drop standalone
 * stopwords and sub-2-char fragments. A comma-delimited phrase stays one token
 * (so `neon glow` is a single token, matching how prompts are authored).
 */
export function tokenizePrompt(prompt: string): string[] {
  if (!prompt) return [];
  return prompt
    .toLowerCase()
    .split(/[,\n]/)
    .map((seg) =>
      seg
        .replace(/:\s*[\d.]+/g, ' ') // strip :1.2 weights
        .replace(/[^a-z0-9 +-]/g, ' ') // strip parens/brackets/other punctuation
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((seg) => seg.length >= 2 && !STOPWORDS.has(seg));
}

export const MIN_CORPUS = 24;
export const MIN_KEPT = 8;
export const MIN_ITEM_KEPT = 3;
export const LIFT_MIN = 1.15;
export const PALETTE_TOP = 20;
export const SETTINGS_TOP = 6;
export const WORKING_TOP = 8;
export const MAX_SUGGESTIONS = 3;
export const CO_OCCUR_MIN = 3;

export interface CraftInsight {
  kind: 'token' | 'model' | 'sampler' | 'cfg' | 'steps' | 'aspect';
  label: string;
  keptCount: number;
  allCount: number;
  lift: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface CraftSuggestion {
  tokens: string[];
  promptText: string;
  keptCount: number;
}

export interface CraftReport {
  ready: boolean;
  totals: { corpus: number; kept: number };
  palette: { label: string; count: number }[];
  settings: {
    model: { label: string; count: number }[];
    sampler: { label: string; count: number }[];
    cfg: { label: string; count: number }[];
    steps: { label: string; count: number }[];
    aspect: { label: string; count: number }[];
  };
  working: CraftInsight[];
  suggestions: CraftSuggestion[];
}

type Labeler = (r: RenderInfo) => string | null;

function stepsBucket(steps: number): string {
  if (steps <= 8) return '1–8 steps';
  if (steps <= 20) return '9–20 steps';
  if (steps <= 35) return '21–35 steps';
  return '36+ steps';
}

const SETTING_LABELERS: { kind: CraftInsight['kind']; label: Labeler }[] = [
  { kind: 'model', label: (r) => (r.modelFamily && r.modelFamily.trim() ? r.modelFamily.trim() : null) },
  { kind: 'sampler', label: (r) => (r.sampler && r.sampler.trim() ? r.sampler.trim() : null) },
  { kind: 'cfg', label: (r) => (typeof r.cfg === 'number' && r.cfg > 0 ? `cfg ${Math.round(r.cfg * 2) / 2}` : null) },
  { kind: 'steps', label: (r) => (typeof r.steps === 'number' && r.steps > 0 ? stepsBucket(r.steps) : null) },
  { kind: 'aspect', label: (r) => r.aspect ?? null },
];

function countBy(items: RenderInfo[], label: Labeler): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of items) {
    const l = label(r);
    if (l) m.set(l, (m.get(l) ?? 0) + 1);
  }
  return m;
}

function topN(m: Map<string, number>, n: number): { label: string; count: number }[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

function confidence(k: number, lift: number): CraftInsight['confidence'] {
  if (k >= 6 && lift >= 1.5) return 'high';
  if (k >= 4 && lift >= 1.3) return 'medium';
  return 'low';
}

function liftItems(
  kind: CraftInsight['kind'],
  allMap: Map<string, number>,
  keptMap: Map<string, number>,
  corpusN: number,
  keptN: number,
): CraftInsight[] {
  const out: CraftInsight[] = [];
  for (const [label, k] of keptMap) {
    if (k < MIN_ITEM_KEPT) continue;
    const a = allMap.get(label) ?? k;
    const lift = k / keptN / (a / corpusN);
    if (lift > LIFT_MIN) {
      out.push({ kind, label, keptCount: k, allCount: a, lift: Math.round(lift * 100) / 100, confidence: confidence(k, lift) });
    }
  }
  return out;
}

export function analyzeCraft(renders: RenderInfo[], recipes: CreativeRecipe[], now: Date): CraftReport {
  void now; // reserved for future recency weighting; keeps the signature parallel to analyzePortfolio
  const corpus = renders.filter((r) => !r.fallback);
  const kept = corpus.filter((r) => r.kept);
  const corpusN = corpus.length;
  const keptN = kept.length;
  const ready = corpusN >= MIN_CORPUS && keptN >= MIN_KEPT;

  const tokenSet = (r: RenderInfo) => new Set(tokenizePrompt(r.prompt));
  const allTok = new Map<string, number>();
  const keptTok = new Map<string, number>();
  const keptTokenSets: Set<string>[] = [];
  for (const r of corpus) for (const t of tokenSet(r)) allTok.set(t, (allTok.get(t) ?? 0) + 1);
  for (const r of kept) {
    const s = tokenSet(r);
    keptTokenSets.push(s);
    for (const t of s) keptTok.set(t, (keptTok.get(t) ?? 0) + 1);
  }

  const palette = topN(allTok, PALETTE_TOP);

  const settingsMaps = SETTING_LABELERS.map((s) => ({
    kind: s.kind,
    all: countBy(corpus, s.label),
    keptM: countBy(kept, s.label),
  }));
  const settings = {
    model: topN(settingsMaps[0].all, SETTINGS_TOP),
    sampler: topN(settingsMaps[1].all, SETTINGS_TOP),
    cfg: topN(settingsMaps[2].all, SETTINGS_TOP),
    steps: topN(settingsMaps[3].all, SETTINGS_TOP),
    aspect: topN(settingsMaps[4].all, SETTINGS_TOP),
  };

  let working: CraftInsight[] = [];
  let suggestions: CraftSuggestion[] = [];
  if (ready) {
    working = [
      ...liftItems('token', allTok, keptTok, corpusN, keptN),
      ...settingsMaps.flatMap((s) => liftItems(s.kind, s.all, s.keptM, corpusN, keptN)),
    ]
      .sort((a, b) => b.lift - a.lift || b.keptCount - a.keptCount || a.label.localeCompare(b.label))
      .slice(0, WORKING_TOP);

    const workingTokens = working.filter((w) => w.kind === 'token').map((w) => w.label);
    const used = new Set<string>();
    const raw: CraftSuggestion[] = [];
    for (const seed of workingTokens) {
      if (used.has(seed)) continue;
      const group = [seed];
      for (const other of workingTokens) {
        if (other === seed || used.has(other) || group.includes(other)) continue;
        const co = keptTokenSets.filter((s) => group.every((g) => s.has(g)) && s.has(other)).length;
        if (co >= CO_OCCUR_MIN) group.push(other);
      }
      if (group.length >= 2) {
        const keptCount = keptTokenSets.filter((s) => group.every((g) => s.has(g))).length;
        if (keptCount >= CO_OCCUR_MIN) {
          group.forEach((g) => used.add(g));
          raw.push({ tokens: group, promptText: group.join(', '), keptCount });
        }
      }
      if (raw.length >= MAX_SUGGESTIONS) break;
    }
    const recipeTokenSets = recipes.map((r) => new Set(tokenizePrompt(r.promptTemplate)));
    suggestions = raw.filter((s) => !recipeTokenSets.some((rs) => s.tokens.every((t) => rs.has(t))));
  }

  return { ready, totals: { corpus: corpusN, kept: keptN }, palette, settings, working, suggestions };
}
