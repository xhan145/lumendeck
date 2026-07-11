# Creative Intelligence — Phase 2 design

**Date:** 2026-07-10
**Version target:** v0.28.0 (minor)
**Sub-project 2 of 3** (Creative-intelligence), **Phase 2 of 3**
**Depends on:** Phase 1 (`craftBrain` engine + Craft view, PR #40). This branch stacks on
`feature/creative-intelligence-p1`; its PR merges after (or on top of) #40.

## Problem

Phase 1 gave the render-level "what's working" craft brain + the Craft view. Phase 2 adds
the **Prompt Lab**: trace how a prompt *evolved* across your renders — auto-grouped
"lineages" of similar prompts over time, the token diff between steps, and a side-by-side
compare of any two renders. It reuses Phase 1's `tokenizePrompt` and the same `RenderInfo`
data; no new backend.

## Core decisions (locked in brainstorming)

- **Interaction = auto lineage timelines** (retrospective), with a side-by-side compare on
  any two renders. (Rejected: manual-only compare bench; live authoring loop — that's Phase 3.)
- **Clustering = greedy by time.** Walk renders oldest→newest; each joins the most
  token-similar existing lineage (Jaccard ≥ `LINEAGE_SIM`) or starts a new one.
  Deterministic, intuitive, testable. (Rejected: global single-link — fuzzier/order-sensitive;
  exact-family-only — misses the evolution.)
- **Placement = a "Lineage" tab in the existing Craft view** (Insights | Lineage). No new
  nav slot; shares the engine + data.

## Architecture

Two units: a pure engine + the Craft-view Lineage tab.

### 1. Engine — `src/core/creative/promptLineage.ts` (pure, reuses `tokenizePrompt`)

`buildLineages(renders: RenderInfo[], opts?: { now?: Date }) → PromptLineage[]`

```ts
interface LineageStep {
  renderId: string;
  added: string[];    // tokens gained vs the previous step
  removed: string[];  // tokens dropped vs the previous step
}
interface PromptLineage {
  id: string;                 // stable id: the first render's id
  renderIds: string[];        // time-ordered (oldest → newest)
  spine: string[];            // tokens present in EVERY render of the line
  steps: LineageStep[];       // one per render; step[0] has empty added/removed
  size: number;               // renderIds.length
}
export interface PromptDiff { added: string[]; removed: string[]; kept: string[] }
export function diffPrompts(prev: string[], next: string[]): PromptDiff;
export interface SettingDelta { key: string; from: string; to: string }
export function diffSettings(a: RenderInfo, b: RenderInfo): SettingDelta[]; // model/sampler/cfg/steps/aspect
```

**Grouping algorithm (`buildLineages`):**
1. Skip fallback renders (reuse Phase 1's exclusion) and renders with empty prompts.
2. Sort by `createdAt` ascending (ties broken by id for determinism).
3. For each render R (tokens `T`), score every existing lineage L by
   `max Jaccard(T, tokens(member))` over L's members; append R to the best L whose score
   `≥ LINEAGE_SIM` (`0.5`); else start a new lineage seeded by R.
4. After grouping: `spine` = tokens common to every member; `steps` = per-member diff vs the
   previous member (`diffPrompts`); `size` = member count.
5. Return only lineages with `size ≥ 2` (a singleton isn't a lineage), sorted by `size` desc
   then most-recent-first.

`Jaccard(a, b) = |a ∩ b| / |a ∪ b|` on the deduped token sets (empty∪empty → 0).

**Constants (named exports, pinned by tests):** `LINEAGE_SIM = 0.5`, `MIN_LINEAGE = 2`,
`MAX_LINEAGES = 40` (cap the list; log/omit note if truncated — never silently).

### 2. UI — Craft view gains an **Insights | Lineage** tab (`CraftInsights.tsx` + `PromptLineage.tsx`)

- `CraftInsights.tsx` gets a lightweight local tab switch (`'insights' | 'lineage'`); the
  Insights content is the existing Phase 1 panel, the Lineage tab renders `<PromptLineage />`.
- `PromptLineage.tsx` subscribes to reactive slices (`gallery`, `creative.brains`, `shelf`)
  and derives `buildLineages(buildAnalysisContext(...).renders)` with `useMemo` (never a
  getter-in-selector). Maps `renderId → gallery item` for thumbnails/prompt/settings.
  Sections:
  - **Lineage list:** each line = a horizontal strip of time-ordered thumbnails + spine chips
    + a size count. Empty/thin → "Not enough related renders yet — keep iterating on prompts."
  - **Expanded timeline** (on select): thumbnails in order, each annotated with its step diff
    (`+neon glow · −blurry`) and setting deltas from the previous.
  - **Compare:** selecting any two renders (within/across lines) shows them side-by-side with
    the full prompt diff + settings diff. Actions: **Restore graph** (`restoreSnapshot`),
    **Make recipe** from the line's spine (`promoteToRecipe({ text: spine.join(', ') })`),
    **Open in gallery**.

## Data flow

gallery + brains + shelf → `buildAnalysisContext` (`RenderInfo[]`) → `buildLineages` →
`PromptLineage[]` → the Lineage tab. Thumbnails/prompts/settings come from the gallery items
resolved by id. "Make recipe" → `promoteToRecipe` (existing).

## Error handling / edge cases

- Fewer than 2 related renders → honest empty state (never a fabricated line).
- A `renderId` whose gallery item was deleted → skipped in the UI (the engine keeps the id;
  the view filters unresolved ids and drops a now-single line).
- Prompts that tokenize to `[]` → excluded (can't be lineaged).
- `MAX_LINEAGES` truncation → a visible "showing N of M" note, never silent.
- Deterministic ordering so the same gallery always yields the same lineages.

## Testing

- `tests/promptLineage.test.ts` (pure): a near-duplicate prompt joins its parent line while
  an unrelated prompt starts a new one; `steps` added/removed correct across a 3-render line;
  `spine` = intersection; `diffPrompts`/`diffSettings` correctness; `LINEAGE_SIM` boundary
  (just-above joins, just-below splits); singleton exclusion; blank/degenerate inputs return
  `[]`; determinism (same input → same output).
- Craft view: a tab-switch test (Insights ↔ Lineage) alongside the existing craft route test;
  browser smoke of the Lineage tab (list renders, expand, compare, empty state).

## Non-goals (Phase 2, deferred)

- Live authoring / iterate-and-re-render loop (**Phase 3** — proactive nudges).
- Semantic/embedding similarity (token-Jaccard only in Phase 2).
- Cross-project lineage; branching/merge visualization beyond linear time-order.

## Rollout

- Bump `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` to `0.28.0`
  (`versionSync.test.ts` guards parity).
- Branch stacks on `feature/creative-intelligence-p1`; the PR notes it depends on #40.
- No public MSI release until explicitly authorized ("release").
