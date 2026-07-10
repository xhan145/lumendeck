# Studio Overview — design spec

**Date:** 2026-07-08
**Status:** Approved (brainstorming)
**Scope:** Sub-project B of "Creative OS + sharing." A read-only, cross-project
**Studio Overview** dashboard (triage-led, backed by insight panels). Out of
scope (separate specs): cross-project bulk editing, hosted/collaborative sharing,
any ML.

## Problem

Every Creative-OS engine today analyzes **one project at a time** (`scoreReadiness`,
`nextAction`, `critiqueProject`, `detectMissing` all take a single `ProjectBrain`).
A user with many projects has no way to see the whole portfolio: which project
deserves attention now, how many actually ship, what consistently stalls them, or
which recipes/types are their strengths. The result is scattered focus and
abandoned projects.

## Goal

One new view — **Studio Overview** — that aggregates **all** project brains:

1. **Triage (leads):** rank every active project by an attention score and surface
   the top project + its single next action ("work on *this* next, because …").
2. **Insight (backs the triage):** finish funnel, the common blocker (weakest
   readiness dimension across unshipped projects), staleness, strengths (top
   recipes / strongest project type), and a velocity trend (started vs shipped).
3. A compact **triage summary card on Mission Control** so the overview is
   discoverable from the default landing.

Deterministic and heuristic — **no ML** (consistent with the field system's honest
framing). Read-only: it routes you *to* the right place; it never mutates a brain.

## Chosen approach

**A new pure `portfolio.ts` engine + a new `StudioOverview` view** (Approach #1 of
3). The engine aggregates the existing per-project engines across all brains into
one `PortfolioReport`; the view renders it. This matches the Creative-OS
convention (every engine is pure + unit-tested) and reuses `scoreReadiness` /
`nextAction` / `detectMissing` rather than re-deriving their logic. (Rejected:
folding panels into Mission Control — bloats/couples the default landing and mixes
per-project with cross-project concerns; ad-hoc computation in the component —
untestable, breaks the pure-engine pattern.)

## Architecture

### New pure engine — `src/core/creative/portfolio.ts`

`analyzePortfolio(brains: ProjectBrain[], recipes: CreativeRecipe[], ctx: AnalysisContext, now: Date): PortfolioReport`

`buildAnalysisContext(gallery, brains, shelf)` already returns ONE shared
`AnalysisContext` (`{ renders, knownModelIds }`) usable for any brain, so the
engine takes that single ctx and calls the per-project engines per brain. The
`recipes` list (`CreativeRecipe[]` from the creative slice) is passed separately
because the context carries recipes by id only, and `topRecipes` needs their
names. `PortfolioReport`:

- `triage: TriageItem[]` — every **non-archived** brain, scored by an **attention
  score** and sorted descending. `TriageItem = { brainId, name, status, readiness,
  attention, action: NextAction }`.
  - **Attention score** (deterministic, documented constants):
    `attention = W_READINESS * (100 - readiness) + W_STALE * min(daysSinceUpdate,
    STALE_CAP_DAYS) + W_BLOCKER * blockerCount`, then **0 for `shipped` /
    `archived`**. `blockerCount` = number of `detectMissing` entries with
    `severity: 'blocker'`. Weights: `W_READINESS=1`, `W_STALE=2`, `W_BLOCKER=15`
    (blockers dominate; ties broken by lower readiness then older `updatedAt`).
    `STALE_CAP_DAYS=30` caps the staleness contribution.
  - `top: TriageItem | null` = `triage[0]` when its attention > 0, else null
    ("portfolio clear").
- `funnel: { byStatus: Record<ProjectStatus, number>, total, shipped, shipRate }`
  — counts across ALL brains (incl. archived); `shipRate = shipped / total` (0
  when total is 0). `ProjectStatus = spark|in-progress|polishing|release-ready|
  shipped|archived`.
- `stall: { dimension: keyof ReadinessDimensions, label, avgScore, affected } |
  null` — average each of the 7 readiness dimensions across **unshipped,
  non-archived** brains; the lowest-average dimension is the common blocker.
  `null` when there are no unshipped projects.
- `stale: StaleItem[]` — non-shipped, non-archived brains with `daysSinceUpdate >=
  STALE_DAYS` (default 14), sorted oldest-first. `StaleItem = { brainId, name,
  daysSinceUpdate }`.
- `strengths: { topRecipes: { id, name, uses }[], strongestType: { type, shipped,
  total, shipRate } | null }` — `topRecipes`: count how many brains reference each
  recipe id (`brain.recipes`), resolve names from the `recipes` param (skip ids
  with no matching recipe), top 5 by uses;
  `strongestType`: the `ProjectType` with the highest ship rate (min 2 projects to
  qualify), null otherwise.
- `velocity: { weeks: { label, started, shipped }[] }` — the last `VELOCITY_WEEKS`
  (default 8) ISO weeks; `started` from `createdAt`, `shipped` from the
  `statusHistory` entry whose `to === 'shipped'` (earliest such per brain).

All timestamps are ISO strings on the brain (`createdAt`, `updatedAt`,
`statusHistory[].at`, `events[].at`); week bucketing uses `now` (passed in) so the
function stays pure/deterministic.

### New view — `src/components/creative/StudioOverview.tsx`

- **Triage header:** the top project as a hero card (name, status chip, readiness
  ring, the next-action `title` + `reason`, a "Work on this" button → `setActiveProject(brainId)` + `setView(action.targetView)`), then a compact ranked list of the next few attention items.
- **Insight grid:** Funnel (status bars + shipRate), "What stalls you" (the stall
  dimension + its avg + affected count), Stale (list with day counts, each a jump
  link), Strengths (top recipes + strongest type), Velocity (a small started-vs-
  shipped bar/sparkline over the weeks).
- Empty state when there are no projects ("No projects yet — create one"); a
  "portfolio clear" state when `top` is null.
- On-brand (cinematic glass, Midnight/Ion Cyan/Voltage Violet); styles in the
  existing `src/styles/creative.css`.

### Wiring

- **`ViewId`** gains `'overview'` (store.ts:140 union). The three-touch
  view-registration gotcha applies: add it to the `ViewId` union, `App.tsx`
  `VIEW_TITLES` + the view-switch ternary, and `NavRail` (a new "Overview" entry in
  the Command group) — all together.
- A store getter `portfolioReport()` = `analyzePortfolio(get().creative.brains,
  get().creative.recipes, analysisContext(), new Date())` (mirrors the existing
  `analysisContext()` getter). The view calls it via `useStudio`.
- **Mission Control card:** a small `PortfolioSummaryCard` on `MissionControl`
  showing `report.top` (or "portfolio clear"), reusing `portfolioReport()`; clicking
  it navigates to the Overview.

## Data flow

```
creative.brains  ──┐
gallery ───────────┼─► buildAnalysisContext(gallery, brains, shelf) ─► ctx
shelf ─────────────┘
        │
        └─ analyzePortfolio(brains, recipes, ctx, now) ─► PortfolioReport
                       │  (per brain: scoreReadiness, nextAction, detectMissing — reused)
                       ▼
             StudioOverview view  +  Mission Control summary card
                       │
                       └─ "Work on this" ─► setActiveProject(id) + setView(action.targetView)
```

## Error handling & edge cases

- **Zero projects** → empty state; `funnel.total=0`, `shipRate=0`, `stall=null`,
  empty arrays. Never divides by zero.
- **All shipped/archived** → `triage` all score 0, `top=null` → "portfolio clear";
  funnel/velocity/strengths still render.
- **Single project** → degrades gracefully (strongestType needs ≥2, so null).
- **Missing/blank timestamps** → treated as `now` for staleness (0 days) and
  excluded from velocity buckets rather than crashing (loud-safe, never throws).
- Pure + deterministic (`now` injected); no network, no mutation.

## Testing

`tests/portfolio.test.ts` (Vitest, pure):

- **Attention ranking:** a blocked, stale, low-readiness project outranks a fresh
  high-readiness one; shipped/archived score 0; tie-break order.
- **`top`:** the highest-attention item, or null when all are shipped/archived.
- **Funnel:** `byStatus` counts + `shipRate` (incl. total=0 → 0).
- **Stall:** the lowest-average readiness dimension across unshipped projects; null
  with no unshipped projects.
- **Stale:** threshold + oldest-first sort; shipped/archived excluded.
- **Strengths:** recipe-use counting across brains (top 5); strongestType ship-rate
  with the ≥2 gate.
- **Velocity:** started (createdAt) and shipped (statusHistory→'shipped') bucketed
  into the right weeks relative to `now`.
- **Empty + single-project** edge cases.

A thin render smoke for `StudioOverview` is optional (the wiring is trivial over
the tested engine); the pure engine carries coverage.

## Rollout

Single PR: `portfolio.ts` + tests + `StudioOverview.tsx` + the Mission Control card
+ view registration (ViewId/App/NavRail) + creative.css. Additive, no flag. Version
bump to the next minor (**0.22.0**). Docs unchanged.

## Out of scope (tracked)

- **Hosted share-links** (Phase 2 of sharing) — its own spec.
- **Video & Motion depth** — its own spec.
- Cross-project bulk editing / collaboration / any ML.
