# Creative Intelligence — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, local `craftBrain` engine that mines the render history (prompt tokens + settings) for your signature patterns and what correlates with the renders you kept, surfaced in a dedicated "Craft" view.

**Architecture:** Additively enrich the existing `RenderInfo` projection with per-render craft fields, add a pure `analyzeCraft(renders, recipes, now)` engine (frequency + confidence-gated lift, same house style as `portfolio.ts`), and render its `CraftReport` in a new `'craft'` nav view. "Make recipe" reuses the existing `promoteToRecipe` store action.

**Tech Stack:** TypeScript, React 18, Zustand, Vite 6, Vitest.

## Global Constraints

- **Version target:** bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` to **0.26.0** in lockstep — `tests/versionSync.test.ts` asserts parity with `APP_VERSION`.
- **Pure engine:** `craftBrain.ts` is deterministic, takes `now: Date` injected, never throws on blank/degenerate input, no store/IDB/ML — mirrors `src/core/creative/portfolio.ts`.
- **Honesty gating:** no prescriptive "what's working" output until `corpus ≥ 24` AND `kept ≥ 8`; copy frames it as correlation, not proof.
- **Curated-actions signal:** `kept = linkedToProject || labeled`; fallback/mock renders excluded from the corpus.
- **Additive migration:** new `RenderInfo` fields are all optional; every existing engine ignores them.
- **Zustand rule:** never call a getter inside a selector; subscribe to slices + derive with `useMemo`.
- **No public MSI release** until the user explicitly says "release".

---

### Task 1: Enrich `RenderInfo` with craft fields

**Files:**
- Modify: `src/core/creative/context.ts` (the `RenderInfo` interface)
- Modify: `src/state/creative.ts` (`buildAnalysisContext`)
- Test: `tests/creativeContext.test.ts`

**Interfaces:**
- Produces: `RenderInfo` gains optional `modelFamily?: string; sampler?: string; steps?: number; cfg?: number; negativePrompt?: string; fallback?: boolean; kept?: boolean;`. `buildAnalysisContext` fills them.

- [ ] **Step 1: Write the failing test**

Create `tests/creativeContext.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildAnalysisContext } from '../src/state/creative';
import type { GalleryItem } from '../src/state/store';
import type { ProjectBrain } from '../src/core/creative/types';

function item(over: Record<string, unknown>): GalleryItem {
  return {
    id: 'g1',
    createdAt: '2026-07-01T00:00:00.000Z',
    dataUrl: '',
    manifest: {
      prompt: 'neon glow, city',
      resolvedPrompt: 'neon glow, city',
      negativePrompt: 'blurry',
      seed: 1,
      canvas: { width: 512, height: 512 },
      sampler: { name: 'euler_a', steps: 20, cfg: 4 },
      model: { id: 'm', name: 'PonyXL', family: 'Pony', hash: 'x' },
      ...(over.render ? { render: over.render } : {}),
    },
    ...over,
  } as unknown as GalleryItem;
}

describe('buildAnalysisContext — craft enrichment', () => {
  it('projects model family, sampler, steps, cfg, negativePrompt from the manifest', () => {
    const ctx = buildAnalysisContext([item({ id: 'a' })], [], []);
    const r = ctx.renders[0];
    expect(r.modelFamily).toBe('Pony');
    expect(r.sampler).toBe('euler_a');
    expect(r.steps).toBe(20);
    expect(r.cfg).toBe(4);
    expect(r.negativePrompt).toBe('blurry');
    expect(r.fallback).toBe(false);
  });

  it('marks kept = tagged OR linked-to-project, and flags fallback renders', () => {
    const tagged = item({ id: 'tag', tags: ['keep'] });
    const linkedId = item({ id: 'lnk' });
    const fb = item({ id: 'fb', render: { mode: 'fallback' } });
    const brain = { id: 'p1', renders: ['lnk'], assets: [] } as unknown as ProjectBrain;
    const ctx = buildAnalysisContext([tagged, linkedId, fb], [brain], []);
    const byId = Object.fromEntries(ctx.renders.map((r) => [r.id, r]));
    expect(byId.tag.kept).toBe(true);   // tagged
    expect(byId.lnk.kept).toBe(true);   // linked to project
    expect(byId.fb.kept).toBe(false);   // untouched
    expect(byId.fb.fallback).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/creativeContext.test.ts`
Expected: FAIL — `r.modelFamily`/`r.kept`/`r.fallback` are `undefined`.

- [ ] **Step 3: Add the fields to `RenderInfo`**

In `src/core/creative/context.ts`, inside `interface RenderInfo`, after `linkedToProject: boolean;`:

```ts
  /** whether this render is still referenced by any project */
  linkedToProject: boolean;
  /** ---- craft-brain fields (optional; other engines ignore them) ---- */
  /** model family from the manifest (e.g. 'SDXL', 'Pony'); '' if none */
  modelFamily?: string;
  /** sampler name from the manifest */
  sampler?: string;
  /** sampler steps */
  steps?: number;
  /** cfg scale */
  cfg?: number;
  /** the render's negative prompt */
  negativePrompt?: string;
  /** true for mock/procedural fallback renders — excluded from the craft corpus */
  fallback?: boolean;
  /** curated-actions signal: linkedToProject OR labeled */
  kept?: boolean;
```

- [ ] **Step 4: Fill them in `buildAnalysisContext`**

In `src/state/creative.ts`, add the import at the top (with the other imports):

```ts
import { isFallbackRender } from '../core/renderHonesty';
```

Replace the `renders` map body so each render carries the new fields:

```ts
  const renders: RenderInfo[] = gallery.map((g) => {
    const canvas = g.manifest?.canvas ?? { width: 0, height: 0 };
    const prompt = g.manifest?.resolvedPrompt || g.manifest?.prompt || '';
    const seed = g.manifest?.seed ?? 0;
    const labeled = Boolean(g.collectionId) || (g.tags?.length ?? 0) > 0;
    const linkedToProject = linked.has(g.id);
    return {
      id: g.id,
      createdAt: g.createdAt,
      aspect: classifyAspect(canvas.width, canvas.height),
      labeled,
      signature: `${prompt}|${seed}|${canvas.width}x${canvas.height}`,
      prompt,
      linkedToProject,
      modelFamily: g.manifest?.model?.family ?? '',
      sampler: g.manifest?.sampler?.name ?? '',
      steps: g.manifest?.sampler?.steps ?? 0,
      cfg: g.manifest?.sampler?.cfg ?? 0,
      negativePrompt: g.manifest?.negativePrompt ?? '',
      fallback: isFallbackRender(g),
      kept: linkedToProject || labeled,
    };
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/creativeContext.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/creative/context.ts src/state/creative.ts tests/creativeContext.test.ts
git commit -m "feat(craft): enrich RenderInfo with craft fields (settings + kept + fallback)"
```

---

### Task 2: `tokenizePrompt`

**Files:**
- Create: `src/core/creative/craftBrain.ts` (start with just the tokenizer)
- Test: `tests/craftBrain.test.ts`

**Interfaces:**
- Produces: `tokenizePrompt(prompt: string): string[]` — lowercase, comma/newline-split, weight/paren-stripped, stopword- and short-filtered phrases.

- [ ] **Step 1: Write the failing test**

Create `tests/craftBrain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tokenizePrompt } from '../src/core/creative/craftBrain';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/craftBrain.test.ts`
Expected: FAIL — cannot resolve `craftBrain`.

- [ ] **Step 3: Write the tokenizer**

Create `src/core/creative/craftBrain.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/craftBrain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/creative/craftBrain.ts tests/craftBrain.test.ts
git commit -m "feat(craft): tokenizePrompt (phrase tokenizer) + tests"
```

---

### Task 3: `analyzeCraft` engine

**Files:**
- Modify: `src/core/creative/craftBrain.ts` (append the engine)
- Test: `tests/craftBrain.test.ts` (append)

**Interfaces:**
- Consumes: `tokenizePrompt` (Task 2); `RenderInfo` craft fields (Task 1); `CreativeRecipe.promptTemplate`.
- Produces:
  - Constants `MIN_CORPUS=24`, `MIN_KEPT=8`, `MIN_ITEM_KEPT=3`, `LIFT_MIN=1.15`, `PALETTE_TOP=20`, `SETTINGS_TOP=6`, `WORKING_TOP=8`, `MAX_SUGGESTIONS=3`, `CO_OCCUR_MIN=3`.
  - Types `CraftInsight`, `CraftSuggestion`, `CraftReport`.
  - `analyzeCraft(renders: RenderInfo[], recipes: CreativeRecipe[], now: Date): CraftReport`.

- [ ] **Step 1: Write the failing tests (append to `tests/craftBrain.test.ts`)**

Add these imports to the top of the file (extend the existing import line):

```ts
import { tokenizePrompt, analyzeCraft, MIN_CORPUS, MIN_KEPT } from '../src/core/creative/craftBrain';
import type { RenderInfo } from '../src/core/creative/context';
import type { CreativeRecipe } from '../src/core/creative/types';
```

Append:

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/craftBrain.test.ts`
Expected: FAIL — `analyzeCraft`/`MIN_CORPUS` not exported.

- [ ] **Step 3: Append the engine to `src/core/creative/craftBrain.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/craftBrain.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/creative/craftBrain.ts tests/craftBrain.test.ts
git commit -m "feat(craft): analyzeCraft engine (lift + gating + suggestions) + tests"
```

---

### Task 4: `'craft'` view — panel, nav, router, Overview link

**Files:**
- Modify: `src/state/store.ts` (`ViewId` union — add `'craft'`)
- Create: `src/components/creative/CraftInsights.tsx`
- Modify: `src/App.tsx` (`VIEW_TITLES` + view router)
- Modify: `src/components/shell/NavRail.tsx` (nav item)
- Modify: `src/components/creative/StudioOverview.tsx` (entry-point button)
- Modify: `src/styles/creative.css` (styles)
- Test: `tests/store.test.ts` (route to `'craft'`)

**Interfaces:**
- Consumes: `analyzeCraft`, `CraftReport` (Task 3); `buildAnalysisContext` (Task 1); store `gallery`/`creative`/`shelf`/`setView`/`promoteToRecipe`.
- Produces: `<CraftInsights />`, `ViewId 'craft'`.

- [ ] **Step 1: Add `'craft'` to the `ViewId` union**

In `src/state/store.ts`, in the `ViewId` union, add `'craft'` right after `'overview'`:

```ts
export type ViewId =
  | 'mission'
  | 'overview'
  | 'craft'
  | 'projects'
```

- [ ] **Step 2: Write the failing route test (append to `tests/store.test.ts`)**

Append:

```ts
describe('studio store — craft view route', () => {
  it('routes to the craft view', () => {
    useStudio.getState().setView('craft');
    expect(useStudio.getState().view).toBe('craft');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/store.test.ts -t "craft view route"`
Expected: FAIL before the `ViewId` edit is saved / PASS only once `'craft'` is a valid `ViewId` (it will fail to typecheck without Step 1). If Step 1 is already saved, this passes — proceed; the real deliverable is the panel below.

- [ ] **Step 4: Create the panel `src/components/creative/CraftInsights.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import { analyzeCraft } from '../../core/creative/craftBrain';
import { buildAnalysisContext } from '../../state/creative';
import { MIN_CORPUS, MIN_KEPT } from '../../core/creative/craftBrain';
import { Icon } from '../icons';
import '../../styles/creative.css';

function Bars({ title, items }: { title: string; items: { label: string; count: number }[] }) {
  if (items.length === 0) return null;
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="craft-dim">
      <span className="craft-dim-title">{title}</span>
      <ul className="craft-bars">
        {items.map((i) => (
          <li key={i.label}>
            <span className="craft-bar-label">{i.label}</span>
            <span className="craft-bar-track"><span className="craft-bar-fill" style={{ width: `${(i.count / max) * 100}%` }} /></span>
            <span className="craft-bar-count">{i.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CraftInsights() {
  const gallery = useStudio((s) => s.gallery);
  const brains = useStudio((s) => s.creative.brains);
  const recipes = useStudio((s) => s.creative.recipes);
  const shelf = useStudio((s) => s.shelf);
  const promoteToRecipe = useStudio((s) => s.promoteToRecipe);
  const setView = useStudio((s) => s.setView);
  const [made, setMade] = useState<string[]>([]);

  const report = useMemo(
    () => analyzeCraft(buildAnalysisContext(gallery, brains, shelf).renders, recipes, new Date()),
    [gallery, brains, shelf, recipes],
  );

  const maxChip = Math.max(1, ...report.palette.map((p) => p.count));
  const suggestions = report.suggestions.filter((s) => !made.includes(s.promptText));

  const make = (promptText: string) => {
    promoteToRecipe({ text: promptText, name: `Craft: ${promptText.slice(0, 32)}` });
    setMade((m) => [...m, promptText]);
  };

  return (
    <main className="studio-page creative-page scroll" aria-label="Craft insights">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Craft insights</p>
            <h1>{Icon.sparkle({ size: 22 })} What's working in your craft</h1>
            <p className="creative-lead">
              Mined from {report.totals.corpus} render{report.totals.corpus === 1 ? '' : 's'} · {report.totals.kept} kept (linked/tagged).
            </p>
          </div>
        </header>

        {report.palette.length === 0 ? (
          <section className="card creative-card"><p className="creative-empty">No real renders yet — generate a few and this fills in.</p></section>
        ) : (
          <>
            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.sparkle({ size: 15 })} Signature palette</h3></div>
              <div className="craft-palette">
                {report.palette.map((p) => (
                  <span key={p.label} className="craft-chip" style={{ fontSize: `${0.8 + (p.count / maxChip) * 0.7}rem`, opacity: 0.55 + (p.count / maxChip) * 0.45 }}>{p.label}</span>
                ))}
              </div>
            </section>

            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} Favored settings</h3></div>
              <div className="craft-dims">
                <Bars title="Model" items={report.settings.model} />
                <Bars title="Sampler" items={report.settings.sampler} />
                <Bars title="CFG" items={report.settings.cfg} />
                <Bars title="Steps" items={report.settings.steps} />
                <Bars title="Aspect" items={report.settings.aspect} />
              </div>
            </section>

            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.trophy({ size: 15 })} What's working</h3></div>
              {report.ready ? (
                <>
                  <p className="craft-note">Correlates with the renders you kept — a signal, not proof.</p>
                  <ul className="craft-working">
                    {report.working.map((w) => (
                      <li key={`${w.kind}:${w.label}`}>
                        <span className="craft-work-label">{w.label}</span>
                        <span className={`chip craft-conf ${w.confidence}`}>{w.confidence}</span>
                        <span className="craft-work-lift">{w.lift}× lift</span>
                        <span className="craft-work-counts">in {w.keptCount} of {w.allCount}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="creative-empty">
                  Not enough signal yet — keep creating and curating (link renders to projects, tag them). Insights unlock at ~{MIN_CORPUS} renders / {MIN_KEPT} kept.
                </p>
              )}
            </section>

            {report.ready && suggestions.length > 0 ? (
              <section className="card creative-card">
                <div className="creative-card-head"><h3>{Icon.beaker({ size: 15 })} Suggested recipes</h3></div>
                <div className="craft-suggestions">
                  {suggestions.map((s) => (
                    <div key={s.promptText} className="craft-suggestion">
                      <span className="craft-suggestion-text">{s.promptText}</span>
                      <span className="craft-suggestion-meta">seen in {s.keptCount} kept</span>
                      <button className="btn tiny" type="button" onClick={() => make(s.promptText)}>Make recipe</button>
                    </div>
                  ))}
                </div>
                <button className="btn tiny" type="button" onClick={() => setView('recipes')}>View recipes</button>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Register the view in `src/App.tsx`**

Add the import near the other creative imports:

```tsx
import { CraftInsights } from './components/creative/CraftInsights';
```

Add the title to `VIEW_TITLES` (after the `overview:` line):

```tsx
  overview: 'Studio Overview',
  craft: 'Craft insights',
```

Add the router branch (after the `overview` branch):

```tsx
      : view === 'overview' ? <StudioOverview />
      : view === 'craft' ? <CraftInsights />
```

- [ ] **Step 6: Add the nav item in `src/components/shell/NavRail.tsx`**

After the `overview` nav item (line ~21):

```tsx
      { id: 'overview', label: 'Overview', icon: () => Icon.target({ size: 22 }) },
      { id: 'craft', label: 'Craft', icon: () => Icon.sparkle({ size: 22 }) },
```

- [ ] **Step 7: Add a discoverability link on Studio Overview**

In `src/components/creative/StudioOverview.tsx`, in the main-return header `<div>` (right after the `<p className="creative-lead">…</p>`), add a small routing button:

```tsx
            <p className="creative-lead">
              {funnel.total} project{funnel.total === 1 ? '' : 's'} · {funnel.shipped} shipped · {Math.round(funnel.shipRate * 100)}% ship rate
            </p>
            <button className="btn tiny" type="button" onClick={() => setView('craft')}>{Icon.sparkle({ size: 13 })} Craft insights</button>
```

(`setView` and `Icon` are already imported in that file.)

- [ ] **Step 8: Styles — append to `src/styles/creative.css`**

```css
/* Craft insights view */
.craft-palette { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.craft-chip { line-height: 1.2; }
.craft-dims { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.craft-dim-title { font-size: 12px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.04em; }
.craft-bars { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.craft-bars li { display: grid; grid-template-columns: 1fr 80px auto; gap: 8px; align-items: center; font-size: 12px; }
.craft-bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.craft-bar-track { height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden; }
.craft-bar-fill { display: block; height: 100%; background: var(--accent, #7aa2ff); }
.craft-bar-count { opacity: 0.6; }
.craft-note { font-size: 12px; opacity: 0.6; margin: 0 0 8px; }
.craft-working { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.craft-working li { display: flex; gap: 10px; align-items: center; font-size: 13px; }
.craft-work-label { font-weight: 600; }
.craft-work-lift { opacity: 0.8; }
.craft-work-counts { opacity: 0.55; font-size: 12px; }
.craft-conf.high { color: #6ee7a8; }
.craft-conf.medium { color: #ffd479; }
.craft-conf.low { opacity: 0.6; }
.craft-suggestions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.craft-suggestion { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 10px; }
.craft-suggestion-text { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.craft-suggestion-meta { opacity: 0.55; font-size: 12px; }
```

- [ ] **Step 9: Run the route test + typecheck + full suite**

Run: `npx vitest run tests/store.test.ts -t "craft view route" && npm run typecheck && npx vitest run`
Expected: PASS — route test green, typecheck clean, all suites green.

- [ ] **Step 10: Commit**

```bash
git add src/state/store.ts src/components/creative/CraftInsights.tsx src/App.tsx src/components/shell/NavRail.tsx src/components/creative/StudioOverview.tsx src/styles/creative.css tests/store.test.ts
git commit -m "feat(craft): Craft insights view (panel + nav + router + Overview link)"
```

---

### Task 5: Version bump + verify + PR

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`

- [ ] **Step 1: Bump to 0.26.0**

Edit each to `0.26.0`:
- `package.json` → `"version": "0.26.0"`
- `src-tauri/tauri.conf.json` → `"version": "0.26.0"`
- `src-tauri/Cargo.toml` → `version = "0.26.0"` (the `[package]` version)
- `src-tauri/Cargo.lock` → the `lumendeck` package block `version = "0.26.0"` (Read, then Edit the exact block).

- [ ] **Step 2: Verify parity + full suite + build**

Run: `npx vitest run tests/versionSync.test.ts && npm run typecheck && npx vitest run && npm run build`
Expected: versionSync PASS (all four sources == `0.26.0` == `APP_VERSION`); full suite green; typecheck clean; production build succeeds.

- [ ] **Step 3: Browser smoke**

Start the dev server, open the app, navigate to **Craft** in the nav. Confirm: signature palette + favored-settings bars render; with a small gallery the "What's working" section shows the honest low-data copy; loading demo data / a larger gallery flips it to lift rows; "Make recipe" on a suggestion adds a recipe (check the Recipes view) and the suggestion leaves the list. Capture a screenshot for the user.

- [ ] **Step 4: Commit + push + PR**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump to v0.26.0 (creative intelligence phase 1)"
git push -u origin feature/creative-intelligence-p1
gh pr create --title "Creative Intelligence — Phase 1: craft brain + Craft view (v0.26.0)" --body "$(cat <<'EOF'
Render-level craft intelligence: mine your prompts + settings for what's working.

- Pure `craftBrain.analyzeCraft` engine: signature palette (recurring prompt tokens), favored settings (model/sampler/cfg/steps/aspect), and confidence-gated **lift** of tokens/settings in the renders you *kept* vs your baseline — plus recipe suggestions from co-occurring high-lift tokens.
- Curated-actions signal (`kept = linked || tagged`); mock/fallback renders excluded; nothing prescriptive until ~24 renders / 8 kept.
- Additive `RenderInfo` enrichment; new "Craft" nav view; "Make recipe" reuses `promoteToRecipe`.
- Phase 1 of 3 (Prompt lab + proactive nudges read the same engine, separate specs).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do NOT cut a public MSI release until the user explicitly says "release".

---

## Notes for the executor

- `crypto`/`Date` in the panel run at runtime (WebView2 + vitest) — fine. The engine takes `now` injected but does not currently use it (reserved); it is passed for signature parity with `analyzePortfolio` and future recency weighting.
- The engine is pure — all correctness is unit-tested in `tests/craftBrain.test.ts`. The panel is straightforward derived rendering; the browser smoke covers wiring.
- Keep the Zustand rule: `CraftInsights` subscribes to slices and derives with `useMemo` — never `useStudio((s) => s.someGetter())`.
