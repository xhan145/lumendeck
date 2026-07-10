# Studio Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, LumenDeck convention) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, cross-project **Studio Overview** dashboard: a pure `analyzePortfolio` engine that aggregates all project brains into a triage ranking + insight panels (funnel, common blocker, staleness, strengths, velocity), a new view rendering it, and a Mission Control summary card.

**Architecture:** One new pure engine `src/core/creative/portfolio.ts` reuses the existing per-project engines (`scoreReadiness`, `nextAction`, `detectMissing`) across all brains and returns a `PortfolioReport`. A thin `StudioOverview` view + a store getter + a Mission Control card render it. Deterministic (`now` injected), no ML, no mutation.

**Tech Stack:** TypeScript, React 18, Zustand, Vitest. Reuses `src/core/creative/{readiness,nextAction,missing,context}.ts`, `src/state/creative.ts` (`buildAnalysisContext`).

## Global Constraints

- **Pure + deterministic:** the engine is DOM-free, takes `now: Date`, never mutates a brain, never throws on bad data (blank timestamps → treated as `now`).
- **No ML:** heuristic scoring only (project convention — honest framing).
- **Reuse, don't duplicate:** call `scoreReadiness(brain, ctx)`, `nextAction(brain, ctx)`, `detectMissing(brain, ctx)`; do NOT re-derive their logic.
- **Constants:** `W_READINESS=1`, `W_STALE=2`, `W_BLOCKER=15`, `STALE_CAP_DAYS=30`, `STALE_DAYS=14`, `VELOCITY_WEEKS=8`.
- **Types (from `src/core/creative/types.ts` + `context.ts`):** `ProjectStatus = 'spark'|'in-progress'|'polishing'|'release-ready'|'shipped'|'archived'`; `ReadinessDimensions` keys = `visualConsistency, assetCompleteness, promptQuality, exportReadiness, fileHygiene, launchReadiness, reusePotential`; `NextAction = {id,title,reason,targetView}`; `CreativeRecipe = {id,name,...}`; `AnalysisContext = {renders,knownModelIds}`; `MissingItem` has `severity: 'blocker'|'warn'`; `ProjectBrain` has `status, type, renders[], recipes[], exports[], statusHistory[{at,from,to}], createdAt, updatedAt`.
- **View registration is a three-touch change:** `ViewId` union (store.ts) + `App.tsx` (`VIEW_TITLES` + the view-switch) + `NavRail` — all together, or the view won't route.
- Tests in `tests/`, run `npx vitest run <file>`; typecheck `npx tsc --noEmit`.

---

### Task 1: Portfolio engine (`portfolio.ts`)

**Files:**
- Create: `src/core/creative/portfolio.ts`
- Test: `tests/portfolio.test.ts`

**Interfaces:**
- Consumes: `scoreReadiness`, `nextAction`, `detectMissing`, `ProjectBrain`, `CreativeRecipe`, `AnalysisContext`, `ProjectStatus`, `ReadinessDimensions`.
- Produces:
  ```ts
  export interface TriageItem { brainId: string; name: string; status: ProjectStatus; readiness: number; attention: number; action: NextAction; }
  export interface StaleItem { brainId: string; name: string; daysSinceUpdate: number; }
  export interface PortfolioReport {
    triage: TriageItem[];
    top: TriageItem | null;
    funnel: { byStatus: Record<ProjectStatus, number>; total: number; shipped: number; shipRate: number };
    stall: { dimension: keyof ReadinessDimensions; label: string; avgScore: number; affected: number } | null;
    stale: StaleItem[];
    strengths: { topRecipes: { id: string; name: string; uses: number }[]; strongestType: { type: string; shipped: number; total: number; shipRate: number } | null };
    velocity: { weeks: { label: string; started: number; shipped: number }[] };
  }
  export function analyzePortfolio(brains: ProjectBrain[], recipes: CreativeRecipe[], ctx: AnalysisContext, now: Date): PortfolioReport;
  ```

- [ ] **Step 1: Write the failing test** (`tests/portfolio.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { analyzePortfolio } from '../src/core/creative/portfolio';
import { emptyContext } from '../src/core/creative/context';
import type { ProjectBrain, ProjectStatus } from '../src/core/creative/types';

const ISO = (d: string) => new Date(d).toISOString();
function brain(over: Partial<ProjectBrain>): ProjectBrain {
  return {
    id: 'b', name: 'B', type: 'artwork', status: 'in-progress',
    logline: '', goals: [], renders: [], recipes: [], assets: [], prompts: [],
    exports: [], publishedLinks: [], events: [], statusHistory: [],
    createdAt: ISO('2026-06-01'), updatedAt: ISO('2026-07-01'),
    ...over,
  } as ProjectBrain;
}
const NOW = new Date('2026-07-08T00:00:00Z');

describe('analyzePortfolio', () => {
  it('ranks a stale, empty, unshipped project above a shipped one; shipped scores 0', () => {
    const needy = brain({ id: 'needy', name: 'Needy', status: 'spark', updatedAt: ISO('2026-06-01') });
    const done = brain({ id: 'done', name: 'Done', status: 'shipped', updatedAt: ISO('2026-07-07') });
    const r = analyzePortfolio([done, needy], [], emptyContext(), NOW);
    expect(r.triage[0].brainId).toBe('needy');
    expect(r.triage.find((t) => t.brainId === 'done')!.attention).toBe(0);
    expect(r.top!.brainId).toBe('needy');
  });

  it('top is null when every project is shipped/archived', () => {
    const r = analyzePortfolio([brain({ status: 'shipped' }), brain({ id: 'c', status: 'archived' })], [], emptyContext(), NOW);
    expect(r.top).toBeNull();
  });

  it('funnel counts by status with a ship rate', () => {
    const bs = [brain({ status: 'shipped' }), brain({ id: '2', status: 'shipped' }), brain({ id: '3', status: 'spark' })];
    const r = analyzePortfolio(bs, [], emptyContext(), NOW);
    expect(r.funnel.total).toBe(3);
    expect(r.funnel.shipped).toBe(2);
    expect(r.funnel.shipRate).toBeCloseTo(2 / 3);
    expect(r.funnel.byStatus.shipped).toBe(2);
  });

  it('funnel shipRate is 0 for an empty portfolio (no divide-by-zero)', () => {
    const r = analyzePortfolio([], [], emptyContext(), NOW);
    expect(r.funnel.total).toBe(0);
    expect(r.funnel.shipRate).toBe(0);
    expect(r.top).toBeNull();
    expect(r.stall).toBeNull();
  });

  it('stall picks the lowest-average readiness dimension across unshipped projects', () => {
    const r = analyzePortfolio([brain({ status: 'in-progress' })], [], emptyContext(), NOW);
    // an empty brain has many weak dimensions; stall must be one of the 7 keys
    expect(r.stall).not.toBeNull();
    expect(typeof r.stall!.dimension).toBe('string');
    expect(r.stall!.avgScore).toBeLessThanOrEqual(100);
  });

  it('stale lists only aged, unshipped projects, oldest first', () => {
    const old = brain({ id: 'old', updatedAt: ISO('2026-06-01') }); // ~37d
    const fresh = brain({ id: 'fresh', updatedAt: ISO('2026-07-07') }); // 1d
    const shippedOld = brain({ id: 'so', status: 'shipped', updatedAt: ISO('2026-05-01') });
    const r = analyzePortfolio([fresh, old, shippedOld], [], emptyContext(), NOW);
    expect(r.stale.map((s) => s.brainId)).toEqual(['old']);
  });

  it('topRecipes counts recipe references across brains and resolves names', () => {
    const recipes = [{ id: 'r1', name: 'Neon' }, { id: 'r2', name: 'Noir' }] as any;
    const bs = [brain({ recipes: ['r1', 'r2'] }), brain({ id: '2', recipes: ['r1'] })];
    const r = analyzePortfolio(bs, recipes, emptyContext(), NOW);
    expect(r.strengths.topRecipes[0]).toMatchObject({ id: 'r1', name: 'Neon', uses: 2 });
  });

  it('strongestType needs >=2 projects of a type; null otherwise', () => {
    const r = analyzePortfolio([brain({ type: 'artwork' as any })], [], emptyContext(), NOW);
    expect(r.strengths.strongestType).toBeNull();
  });

  it('velocity buckets started (createdAt) and shipped (statusHistory->shipped) into weeks', () => {
    const b = brain({
      createdAt: ISO('2026-07-06'),
      statusHistory: [{ at: ISO('2026-07-07'), from: 'release-ready', to: 'shipped' }] as any,
      status: 'shipped',
    });
    const r = analyzePortfolio([b], [], emptyContext(), NOW);
    const totalStarted = r.velocity.weeks.reduce((a, w) => a + w.started, 0);
    const totalShipped = r.velocity.weeks.reduce((a, w) => a + w.shipped, 0);
    expect(totalStarted).toBe(1);
    expect(totalShipped).toBe(1);
    expect(r.velocity.weeks.length).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/portfolio.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the implementation** (`src/core/creative/portfolio.ts`)

Compose small helpers: `attentionScore(brain, readiness, blockerCount, now)` (returns 0 for shipped/archived else `W_READINESS*(100-readiness)+W_STALE*min(daysSince(updatedAt,now),STALE_CAP_DAYS)+W_BLOCKER*blockerCount`); `daysSince(iso, now)` (guards blank/NaN → 0); `computeFunnel(brains)`; `computeStall(brains, ctx)` (average each `scoreReadiness(b,ctx).dimensions[key]` over unshipped/non-archived, pick min; DIMENSION_LABELS map); `computeStale(brains, now)`; `computeStrengths(brains, recipes)`; `computeVelocity(brains, now)` (8 week buckets by `startOfWeek`/`weekKey`, `started` from createdAt, `shipped` from the earliest `statusHistory` entry with `to==='shipped'`). `analyzePortfolio` calls `scoreReadiness`/`nextAction`/`detectMissing` per brain, builds `triage` (non-archived), sorts by attention desc then readiness asc then older updatedAt, sets `top = triage[0]?.attention>0 ? triage[0] : null`, and assembles the report.

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run tests/portfolio.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/creative/portfolio.ts tests/portfolio.test.ts
git commit -m "feat(creative): analyzePortfolio engine — cross-project triage + insights"
```

---

### Task 2: Studio Overview view + store getter + view registration

**Files:**
- Create: `src/components/creative/StudioOverview.tsx`
- Modify: `src/state/store.ts` (add `ViewId` `'overview'`; add getter `portfolioReport()`)
- Modify: `src/App.tsx` (`VIEW_TITLES['overview']` + render `StudioOverview` for that view)
- Modify: `src/components/NavRail.tsx` (add an "Overview" entry in the Command group)
- Modify: `src/styles/creative.css` (overview styles)

**Interfaces:**
- Consumes: `analyzePortfolio` (Task 1), `useStudio`, `analysisContext()` getter, `setActiveProject`, `setView`.
- Produces: `portfolioReport(): PortfolioReport` on the store; `viewId 'overview'`.

- [ ] **Step 1: Add the store getter + ViewId.** In `store.ts`: add `'overview'` to the `ViewId` union; add `portfolioReport: () => PortfolioReport;` to the store type; implement `portfolioReport: () => analyzePortfolio(get().creative.brains, get().creative.recipes, buildAnalysisContext(get().gallery, get().creative.brains, get().shelf), new Date())`. Typecheck.

- [ ] **Step 2: Build `StudioOverview.tsx`.** `const report = useStudio((s) => s.portfolioReport());` Render: empty state when `report.funnel.total===0`; a triage hero for `report.top` (name, status chip, readiness, `action.title` + `action.reason`, a "Work on this" button → `setActiveProject(top.brainId)` then `setView(top.action.targetView)`); the ranked `triage` list (skip the top); insight panels — Funnel (bars from `byStatus` + shipRate %), "What stalls you" (`stall.label`, `avgScore`, `affected`), Stale (list with `daysSinceUpdate`, each button → open project), Strengths (`topRecipes` chips + `strongestType`), Velocity (8 small started/shipped bars). Guard every `null` (`top`, `stall`, `strongestType`).

- [ ] **Step 3: Register the view.** `App.tsx`: `VIEW_TITLES.overview = 'Studio Overview'` and render `<StudioOverview/>` when `view==='overview'`. `NavRail.tsx`: an "Overview" button (Command group) calling `setView('overview')`, active when `view==='overview'`.

- [ ] **Step 4: Typecheck + build** — `npx tsc --noEmit` clean; `npm run build` OK.

- [ ] **Step 5: Commit**

```bash
git add src/components/creative/StudioOverview.tsx src/state/store.ts src/App.tsx src/components/NavRail.tsx src/styles/creative.css
git commit -m "feat(creative): Studio Overview view + portfolioReport getter + nav"
```

---

### Task 3: Mission Control summary card

**Files:**
- Modify: `src/components/creative/MissionControl.tsx`

**Interfaces:**
- Consumes: `portfolioReport()`, `setView`.

- [ ] **Step 1: Add a `PortfolioSummaryCard`** to Mission Control: read `portfolioReport()`; show `report.top` ("Work on next: {name} — {action.title}") or "Portfolio clear" when null, plus a one-line funnel (`{shipped}/{total} shipped`); the card is a button → `setView('overview')`. Reuse existing card styles.

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/creative/MissionControl.tsx
git commit -m "feat(creative): Mission Control portfolio summary card links to Overview"
```

---

### Task 4: Version bump + full verification

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` → `0.22.0`

- [ ] **Step 1: Bump all four to `0.22.0`** (APP_VERSION auto-follows; `versionSync.test.ts` confirms).

- [ ] **Step 2: Full verify** — `npx tsc --noEmit && npx vitest run` → tsc clean, all green (incl. `versionSync` + the new `portfolio` suite).

- [ ] **Step 3: Browser smoke** — `npm run dev`, seed the creative demo (Mission Control "Load demo"), open the Overview, confirm the triage hero + panels render with no console errors; screenshot/eval-verify.

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump to 0.22.0 (Studio Overview)"
```

---

## Self-Review

**Spec coverage:** Triage + attention score → Task 1. Funnel/stall/stale/strengths/velocity → Task 1. Studio Overview view + navigation → Task 2. Mission Control card → Task 3. Version bump/rollout → Task 4. Determinism/no-ML/edge cases → Task 1 tests (empty, all-shipped, single). All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; Task 1 has full test + implementation-shape; the UI tasks (2,3) describe exact data bindings + handlers over the tested engine rather than full JSX (justified: thin glue over the tested `PortfolioReport`, depends on exact live component code read at execution time).

**Type consistency:** `analyzePortfolio(brains, recipes, ctx, now)`, `PortfolioReport`, `TriageItem`, `StaleItem`, `portfolioReport()`, `viewId 'overview'`, the 7 `ReadinessDimensions` keys, and `ProjectStatus` values are used identically across tasks and match `types.ts`/`context.ts`. `NextAction.targetView` drives navigation.
