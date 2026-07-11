# Creative Intelligence — Phase 3 design

**Date:** 2026-07-10
**Version target:** v0.29.0 (minor)
**Sub-project 2 of 3** (Creative-intelligence), **Phase 3 of 3** — the finale.
**Depends on:** Phase 1 (`craftBrain`, PR #40) + Phase 2 (`promptLineage`, PR #42). This branch
stacks on `feature/creative-intelligence-p2`; its PR merges after #40 then #42.

## Problem

Phases 1–2 mine the render history (what's working; how prompts evolved) and surface it in the
Craft view — a *retrospective* surface you visit. Phase 3 closes the loop by bringing those
signals to **authoring time**: while you compose a prompt, a **Prompt Coach** proactively
suggests what your own history says to try — high-lift tokens you haven't used here, the
existing "line" your prompt resembles, and a matching recipe — each one-click and append-only.
It reuses both engines; no backend.

## Core decisions (locked in brainstorming)

- **Surface = a reactive suggestions panel** (a "Coach" tab in `PromptStudio`), never a
  popup/as-you-type dropdown (rejected as intrusive) and not just a single nudge bar (too
  narrow). Proactive but opt-in, consistent with the existing tabbed prompt tools.
- **Sources = all three:** add-token (from `craftBrain` working tokens), resembles-a-line
  (from `promptLineage` spines), apply-recipe (from `creative.recipes`).
- **Apply = append-only** (never overwrite what you typed): add-token appends `, <token>`;
  apply-line appends the missing spine tokens; apply-recipe uses the existing
  `applyCreativeRecipe`.

## Architecture

Two units: a pure engine + the `PromptStudio` Coach tab.

### 1. Engine — `src/core/creative/promptCoach.ts` (pure, reuses P1 + P2)

`coach(currentPrompt: string, craftReport: CraftReport, lineages: PromptLineage[], recipes: CreativeRecipe[]): CoachSuggestion[]`

```ts
interface CoachSuggestion {
  kind: 'add-token' | 'apply-line' | 'apply-recipe';
  label: string;        // display text, e.g. 'neon glow'
  reason: string;       // e.g. '2.1× in your kept work' / 'looks like your "neon glow, city" line'
  tokens: string[];     // tokens this suggestion would APPEND (add-token: 1; apply-line: the missing spine tokens)
  recipeId?: string;    // set for apply-recipe
}
```

**Algorithm (all deterministic; each source SELF-gates — no blanket gate):**
1. `currentTokens = new Set(tokenizePrompt(currentPrompt))`. No blanket `ready` gate: add-token
   draws from `craftReport.working`, which Phase 1 already leaves EMPTY until the corpus is ready
   (so add-token naturally stays silent on thin data); apply-line needs a real lineage (≥2 similar
   renders); apply-recipe needs a matching recipe. When nothing fires, `coach()` returns `[]` and
   the panel shows the honest empty state — advice is never invented from noise.
2. **add-token:** from `craftReport.working.filter(w => w.kind === 'token' && !currentTokens.has(w.label))`,
   take the top `MAX_TOKEN_SUGGESTIONS (5)` (already lift-ranked by `analyzeCraft`). Each →
   `{ kind:'add-token', label:w.label, reason:`${w.lift}× in your kept work`, tokens:[w.label] }`.
3. **apply-line:** for each `PromptLineage`, `score = jaccard(currentTokens, new Set(spine))`;
   pick the best with `score ≥ COACH_SIM (0.3)` AND ≥1 spine token missing from current →
   `{ kind:'apply-line', label:spine.slice(0,3).join(', '), reason:'looks like your "…" line',
   tokens: spine.filter(t => !currentTokens.has(t)) }`. At most 1.
4. **apply-recipe:** for each recipe, `score = jaccard(currentTokens, new Set(tokenizePrompt(recipe.promptTemplate)))`;
   pick the best with `score ≥ COACH_SIM` → `{ kind:'apply-recipe', label:recipe.name,
   reason:'a recipe that matches this prompt', tokens:[], recipeId:recipe.id }`. At most 1.
5. Return `[...addTokens, applyLine?, applyRecipe?]` (order: tokens first, then line, then
   recipe), filtering out any `add-token`/`apply-line` whose `tokens` is empty.

**Constants (named exports, pinned by tests):** `MAX_TOKEN_SUGGESTIONS = 5`, `COACH_SIM = 0.3`.
Reuses `tokenizePrompt` (P1) and a small local `jaccard` (or import the one factored out for
lineage — keep one copy; if `promptLineage` doesn't export it, add a shared `tokenJaccard` there
and import it in both). `craftReport` comes from `analyzeCraft`, `lineages` from `buildLineages`.

### 2. UI — a **"Coach" tab in `PromptStudio`** (`src/components/prompt/PromptStudio.tsx`)

- Add `'coach'` to the `Tab` union + the tabs list; render `<PromptCoachTab />` when active.
- `PromptCoachTab` (new component in the same file or `PromptCoachTab.tsx`): subscribes to the
  live `workflow` (to read the `prompt` node's `positive`), `gallery`, `creative.brains`,
  `creative.recipes`, `shelf`; derives `coach(positive, analyzeCraft(ctx.renders, recipes, now),
  buildLineages(ctx.renders), recipes)` with `useMemo`. Renders the suggestions as rows/chips:
  - **add-token** → a chip `+ <token>` with the reason; click appends `, <token>` to the prompt
    node's `positive` via the store's param update.
  - **apply-line** → "Add N missing from your *…* line"; click appends `, ` + the missing tokens.
  - **apply-recipe** → "Apply *<name>*"; click calls `applyCreativeRecipe(recipeId, subject)`
    (subject = the current positive, or ''), which the store already implements.
  - Honest empty state when `coach()` returns `[]`: "Keep creating — suggestions appear as your
    craft history grows."
- Append helper: read the current `prompt` node `positive`, set it to
  `positive.trim() ? `${positive.trim()}, ${added}` : added` via `updateParam(promptNodeId, 'positive', …)`.

## Data flow

live `prompt.positive` + gallery/brains/shelf → `buildAnalysisContext` → `analyzeCraft` +
`buildLineages` → `coach(...)` → `CoachSuggestion[]` → the Coach tab. Apply → `updateParam`
(append) or `applyCreativeRecipe`. Everything re-derives via `useMemo` on the next edit.

## Error handling / edge cases

- No craft signal → `craftReport.working` is `[]` (Phase 1's readiness gate) → no add-token
  suggestions; if no lineage/recipe matches either, `coach()` returns `[]` → honest empty state.
- Empty current prompt → token nudges still allowed (seed a blank prompt); line/recipe need
  ≥1 current token to match, so they naturally don't fire on blank.
- A suggested token already present (case/spacing) → excluded (Set membership on `tokenizePrompt`).
- `apply-line`/`add-token` with an empty `tokens` array → filtered out (nothing to append).
- Append never overwrites: it concatenates with a comma; trims to avoid a leading comma.
- Missing `prompt` node → the append is a no-op guarded by a null check (never throws).

## Testing

- `tests/promptCoach.test.ts` (pure): add-token excludes already-present tokens + preserves the
  lift ordering + caps at `MAX_TOKEN_SUGGESTIONS`; resembles-a-line picks the best spine ≥
  `COACH_SIM` and lists ONLY the missing tokens; apply-recipe matches by overlap and sets
  `recipeId`; add-token yields nothing when `craftReport.working` is empty (P1 not ready) while
  apply-line/apply-recipe still fire on their own signal; `coach()` returns `[]` when no source
  fires; empty-prompt + degenerate inputs are safe; determinism (same inputs → same output).
- `PromptStudio`: a tab-switch test (Coach tab selectable) + a store append test (appending a
  token to a blank vs non-blank `positive` produces the right comma-joined string via the
  existing param-update path); browser smoke of the Coach tab (suggestions render, click appends).

## Non-goals (Phase 3, deferred)

- As-you-type autocomplete / caret tracking (rejected as intrusive).
- Semantic/embedding similarity (token-Jaccard only).
- Auto-applying anything (always one-click, append-only).
- Cross-project coaching; negative-prompt coaching.

## Rollout

- Bump `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` to `0.29.0`
  (`versionSync.test.ts` guards parity).
- Branch stacks on `feature/creative-intelligence-p2`; the PR notes it depends on #40 → #42.
- No public MSI release until explicitly authorized ("release").
