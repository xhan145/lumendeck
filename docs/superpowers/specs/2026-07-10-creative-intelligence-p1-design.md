# Creative Intelligence — Phase 1 design

**Date:** 2026-07-10
**Version target:** v0.26.0 (minor)
**Sub-project 2 of 3** (Unpublish → **Creative-intelligence** → Temporal-coherence)
**Phase 1 of 3** (craftBrain engine + "What's working" panel → Prompt lab → Proactive nudges)

## Problem

Every intelligence surface in LumenDeck today is **project-level**: `portfolio.ts`
(triage/funnel/stall/velocity/strengths), `critic.ts` (readiness dimensions →
strengths/risks/fixes), `entropy.ts`, `nextAction.ts`, `readiness.ts`. Nothing mines
the **render history** — the actual prompts and settings (model / sampler / cfg / steps
/ aspect) of your generations — for craft-level patterns. So the app can tell you *which
project to work on* but not *what's working in how you actually generate*.

Creative Intelligence adds a **render-level craft brain** that mines your generation
history and surfaces your patterns and what correlates with the work you kept. This is
Phase 1: the shared engine plus its primary read surface. Phases 2 (prompt lab / lineage)
and 3 (proactive in-editor nudges) read the same engine and are separate specs.

## Core decisions (locked in brainstorming)

- **Outcome signal = curated actions.** A render counts as "kept" if you took an action
  on it: linked to a project OR tagged OR in a collection. Mock/fallback renders are
  excluded from the corpus entirely; near-duplicates are de-weighted. No new UI, honest,
  available today. (Rejected: an explicit ★ favorite — needs new UI + cold start;
  shipped-only — too sparse.)
- **Method = frequency + lift, confidence-gated.** For each prompt token and each
  setting, compute `lift = P(item | kept) / P(item | all)` and surface the top
  positive-lift items, **hidden until the corpus is large enough**, with an honest
  confidence label. (Rejected: clustering-first — fuzzy, hard to test, though a light
  version is used for recipe grouping; descriptive-only — punts the core ask.)
- **Placement = dedicated "Craft" nav view.** Render-level craft is a different lens
  from the project hub, and Phases 2–3 extend this surface.

## Architecture

Three well-bounded units + one additive data enrichment.

### 1. Data — additive `RenderInfo` enrichment (`src/core/creative/context.ts`)

`RenderInfo` today carries `{ id, createdAt, aspect, labeled, signature, prompt,
linkedToProject }`. Add optional craft fields (every existing engine ignores them):

```ts
interface RenderInfo {
  // ...existing...
  modelFamily?: string;   // manifest.model?.family (e.g. 'SDXL', 'Pony'), '' if none
  sampler?: string;       // manifest.sampler.name
  steps?: number;         // manifest.sampler.steps
  cfg?: number;           // manifest.sampler.cfg
  negativePrompt?: string;
  fallback?: boolean;     // mock/procedural render — excluded from the craft corpus
  kept?: boolean;         // linkedToProject || labeled — the curated-actions signal
}
```

`buildAnalysisContext` (`src/state/creative.ts`) fills these from each `GalleryItem`'s
manifest and the existing `isFallbackRender` honesty check. Pure; the projection stays
render-metadata-only (no image bytes).

### 2. Engine — `src/core/creative/craftBrain.ts` (pure, deterministic, no ML)

`analyzeCraft(renders: RenderInfo[], recipes: CreativeRecipe[], now: Date): CraftReport`
— same house style as `portfolio.ts` (injected `now`, never throws, no store/IDB).

**Corpus:** all non-fallback renders. `kept = renders.filter(r => r.kept)`.

**Tokenization** (`tokenizePrompt`, exported + tested): lowercase; split on commas and
newlines; strip weight syntax (`(tok:1.2)` → `tok`), enclosing parens/brackets, and
leading/trailing punctuation; drop a small stopword set and tokens < 2 chars; collapse
whitespace. A "token" is a normalized phrase between commas (so `neon glow` stays one
token, matching how prompts are authored). Deduplicate per-render (a token counts once
per render).

**Settings buckets:** `modelFamily` (raw), `sampler` (raw), `aspect` (raw), `cfg`
(rounded to nearest 0.5), `steps` (bucketed: 1–8 / 9–20 / 21–35 / 36+).

**`CraftReport` shape:**

```ts
interface CraftInsight {          // one "what's working" item
  kind: 'token' | 'model' | 'sampler' | 'cfg' | 'steps' | 'aspect';
  label: string;                  // e.g. 'neon glow', 'Pony', 'cfg 4', '9–20 steps'
  keptCount: number;              // # kept renders containing it
  allCount: number;               // # corpus renders containing it
  lift: number;                   // P(item|kept) / P(item|all), rounded 2dp
  confidence: 'high' | 'medium' | 'low';
}
interface CraftSuggestion {       // a proposed recipe from co-occurring high-lift tokens
  tokens: string[];               // the pattern
  promptText: string;             // tokens.join(', ') — feeds promoteToRecipe
  keptCount: number;
}
interface CraftReport {
  ready: boolean;                 // false when under the data threshold
  totals: { corpus: number; kept: number };
  palette: { label: string; count: number }[];        // signature tokens, top ~20 by freq
  settings: {
    model: { label: string; count: number }[];
    sampler: { label: string; count: number }[];
    cfg: { label: string; count: number }[];
    steps: { label: string; count: number }[];
    aspect: { label: string; count: number }[];
  };
  working: CraftInsight[];        // top positive-lift items, [] until ready
  suggestions: CraftSuggestion[]; // ≤3, [] until ready or none clear existing recipes
}
```

**Lift + gating (the honesty core):**
- `ready = totals.corpus >= MIN_CORPUS (24) && totals.kept >= MIN_KEPT (8)`. Under that,
  `working` and `suggestions` are `[]` and the panel shows the honest low-data state
  (palette/settings still render — they're descriptive, always safe).
- An item enters `working` only if `keptCount >= MIN_ITEM_KEPT (3)` AND `lift > 1.15`.
  Confidence: `high` if `keptCount >= 6 && lift >= 1.5`; `medium` if `keptCount >= 4 &&
  lift >= 1.3`; else `low`. Sorted by `lift` desc then `keptCount` desc; top ~8.
- **Suggestions:** take the working *tokens* (kind==='token'), greedily group tokens that
  co-occur in ≥3 kept renders into ≤3 patterns, drop any pattern whose token set is
  already covered by an existing recipe's prompt (normalized token compare), and emit the
  remainder as `CraftSuggestion`s. (Light clustering — no ML.)

All thresholds are named exported constants so tests pin them.

### 3. Panel — `src/components/creative/CraftInsights.tsx` (own "Craft" view)

- New `ViewId 'craft'` in the store + a nav entry (follows the existing view-registration
  pattern used by `'overview'`). Subscribes to reactive slices (`gallery`, `creative.brains`,
  `creative.recipes`, `shelf`) and derives the report with `useMemo(() => analyzeCraft(...))`
  — **never a getter-in-selector** (Zustand cached-snapshot rule).
- Sections:
  - **Signature palette** — weighted token chips (size/opacity by frequency).
  - **Favored settings** — five compact distribution bars (model / sampler / cfg / steps /
    aspect).
  - **What's working** — `working` items as rows: label · `lift ×` · "in N of M kept" ·
    confidence badge. Honest header copy: "Correlates with the renders you kept — not proof."
  - **Suggested recipes** — cards per `CraftSuggestion` with a **Make recipe** button →
    existing `promoteToRecipe({ text: promptText, name })`; on click, toast + the card
    leaves the list (the pattern now maps to a recipe).
  - **Low-data / empty state** — when `!ready`: "Not enough signal yet — keep creating and
    curating (link renders to projects, tag them). Insights unlock at ~24 renders / 8
    kept." Palette + settings still show if any corpus exists.
- Also add a small **"Craft insights"** entry-point button on Studio Overview that routes
  to the Craft view (discoverability without duplicating the panel).

## Data flow

Gallery + brains + shelf → `buildAnalysisContext` (enriched `RenderInfo[]`) →
`analyzeCraft(renders, recipes, now)` → `CraftReport` → `CraftInsights` view. "Make
recipe" → `promoteToRecipe` (existing store action) mutates `creative.recipes`, which
re-runs the memo and drops the satisfied suggestion.

## Error handling / edge cases

- Empty/degenerate corpus → `ready:false`, empty arrays, low-data state (never throws).
- All renders fallback → corpus 0 → low-data state.
- No kept renders → `working`/`suggestions` empty even if corpus is large; palette/settings
  still render.
- Prompts with only stopwords/punctuation → tokenizer yields `[]`, render contributes
  nothing (no crash, no empty-string token).
- A suggestion whose tokens already match a recipe is dropped (no dupes).

## Testing

- `tests/craftBrain.test.ts` (pure): `tokenizePrompt` (weights, parens, stopwords, dedupe,
  empty); lift math + confidence tiers at the threshold boundaries; `ready` gating hides
  `working`/`suggestions` under `MIN_CORPUS`/`MIN_KEPT`; a kept-token with high lift
  surfaces with correct confidence; suggestion clustering groups co-occurring tokens and
  **drops** ones already covered by a recipe; blank/degenerate inputs return a safe empty
  report.
- `tests/creativeContext.test.ts` (or extend an existing context test): `buildAnalysisContext`
  populates the new `RenderInfo` craft fields from a manifest and sets `kept`/`fallback`
  correctly.
- Store/view: a `'craft'` route test (setView('craft') works) alongside the existing
  view-routing test; browser smoke of the panel (palette + settings render; low-data state;
  "Make recipe" adds a recipe and drops the suggestion).

## Non-goals (Phase 1)

- Prompt lab / lineage explorer (**Phase 2** — separate spec, reads this engine).
- Proactive in-editor nudges (**Phase 3** — separate spec).
- An explicit ★ favorite/rating primitive (may revisit if the curated signal proves thin).
- Any cloud/LLM analysis — the engine is pure and local.
- Image-content analysis (CLIP/embeddings) — text + settings only in Phase 1.

## Rollout

- Bump `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` to `0.26.0`
  (`versionSync.test.ts` guards parity).
- No public MSI release until explicitly authorized ("release").
