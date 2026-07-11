# Creative Intelligence — Phase 2 (Prompt Lab / Lineage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Prompt Lab" that auto-groups renders into time-ordered prompt lineages (by token similarity), shows the token diff between steps, and lets you compare any two renders side-by-side — as a new "Lineage" tab in the existing Craft view.

**Architecture:** A pure `promptLineage.ts` engine (greedy-by-time Jaccard clustering over `tokenizePrompt`) produces `PromptLineage[]` from the existing `RenderInfo[]`. The Craft view (`CraftInsights.tsx`) gains an Insights | Lineage tab; the Lineage tab renders a new `PromptLineage.tsx` that maps render ids → gallery items for thumbnails and drives expand + compare.

**Tech Stack:** TypeScript, React 18, Zustand, Vite 6, Vitest.

## Global Constraints

- **Version target:** bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` to **0.28.0** (`tests/versionSync.test.ts` guards parity with `APP_VERSION`).
- **Depends on Phase 1:** this branch stacks on `feature/creative-intelligence-p1` (PR #40) — it imports `tokenizePrompt` from `craftBrain.ts` and the enriched `RenderInfo` fields. The PR notes the dependency.
- **Pure engine:** `promptLineage.ts` is deterministic (stable sort by time then id), never throws on blank/degenerate input, no store/ML — mirrors `craftBrain.ts`/`portfolio.ts`.
- **Honesty:** fewer than 2 related renders → an honest empty state, never a fabricated line. `MAX_LINEAGES` truncation shows a visible "showing N of M" note, never silent.
- **Zustand rule:** never call a getter inside a selector; subscribe to slices + derive with `useMemo`.
- **No public MSI release** until the user explicitly says "release".

---

### Task 1: `promptLineage.ts` engine + tests

**Files:**
- Create: `src/core/creative/promptLineage.ts`
- Test: `tests/promptLineage.test.ts`

**Interfaces:**
- Consumes: `tokenizePrompt` (from `craftBrain.ts`); `RenderInfo` (`id`, `createdAt`, `prompt`, `fallback`, `modelFamily`, `sampler`, `cfg`, `steps`, `aspect`).
- Produces:
  - Constants `LINEAGE_SIM = 0.5`, `MIN_LINEAGE = 2`, `MAX_LINEAGES = 40`.
  - `interface LineageStep { renderId: string; added: string[]; removed: string[] }`
  - `interface PromptLineage { id: string; renderIds: string[]; spine: string[]; steps: LineageStep[]; size: number }`
  - `interface PromptDiff { added: string[]; removed: string[]; kept: string[] }`
  - `interface SettingDelta { key: string; from: string; to: string }`
  - `diffPrompts(prev: string[], next: string[]): PromptDiff`
  - `diffSettings(a: RenderInfo, b: RenderInfo): SettingDelta[]`
  - `buildLineages(renders: RenderInfo[]): PromptLineage[]` (full sorted list; the UI caps at `MAX_LINEAGES`)

- [ ] **Step 1: Write the failing tests**

Create `tests/promptLineage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/promptLineage.test.ts`
Expected: FAIL — cannot resolve `promptLineage`.

- [ ] **Step 3: Implement `src/core/creative/promptLineage.ts`**

```ts
/**
 * Prompt Lab lineage engine: groups renders into time-ordered "prompt lines" by prompt
 * token similarity (greedy by time, Jaccard >= LINEAGE_SIM), and diffs prompts/settings
 * for the compare view. Pure + deterministic (stable sort by time then id); reuses
 * craftBrain's tokenizePrompt. No store/ML. Mirrors the house engine style.
 */
import type { RenderInfo } from './context';
import { tokenizePrompt } from './craftBrain';

export const LINEAGE_SIM = 0.5;
export const MIN_LINEAGE = 2;
export const MAX_LINEAGES = 40;

export interface LineageStep {
  renderId: string;
  added: string[];
  removed: string[];
}
export interface PromptLineage {
  id: string;
  renderIds: string[];
  spine: string[];
  steps: LineageStep[];
  size: number;
}
export interface PromptDiff {
  added: string[];
  removed: string[];
  kept: string[];
}
export interface SettingDelta {
  key: string;
  from: string;
  to: string;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function diffPrompts(prev: string[], next: string[]): PromptDiff {
  const p = new Set(prev);
  const n = new Set(next);
  return {
    added: [...n].filter((t) => !p.has(t)),
    removed: [...p].filter((t) => !n.has(t)),
    kept: [...n].filter((t) => p.has(t)),
  };
}

function settingStr(rr: RenderInfo, key: string): string {
  switch (key) {
    case 'model': return rr.modelFamily && rr.modelFamily.trim() ? rr.modelFamily.trim() : '—';
    case 'sampler': return rr.sampler && rr.sampler.trim() ? rr.sampler.trim() : '—';
    case 'cfg': return typeof rr.cfg === 'number' && rr.cfg > 0 ? `${rr.cfg}` : '—';
    case 'steps': return typeof rr.steps === 'number' && rr.steps > 0 ? `${rr.steps}` : '—';
    case 'aspect': return rr.aspect ?? '—';
    default: return '—';
  }
}

export function diffSettings(a: RenderInfo, b: RenderInfo): SettingDelta[] {
  const out: SettingDelta[] = [];
  for (const key of ['model', 'sampler', 'cfg', 'steps', 'aspect']) {
    const from = settingStr(a, key);
    const to = settingStr(b, key);
    if (from !== to) out.push({ key, from, to });
  }
  return out;
}

export function buildLineages(renders: RenderInfo[]): PromptLineage[] {
  const items = renders
    .filter((rr) => !rr.fallback)
    .map((rr) => ({ r: rr, tokens: new Set(tokenizePrompt(rr.prompt)) }))
    .filter((x) => x.tokens.size > 0)
    .sort((x, y) => {
      const tx = Date.parse(x.r.createdAt);
      const ty = Date.parse(y.r.createdAt);
      const nx = Number.isFinite(tx) ? tx : 0;
      const ny = Number.isFinite(ty) ? ty : 0;
      return nx - ny || x.r.id.localeCompare(y.r.id);
    });

  type Member = { r: RenderInfo; tokens: Set<string> };
  const groups: Member[][] = [];
  for (const it of items) {
    let best: Member[] | null = null;
    let bestScore = 0;
    for (const g of groups) {
      let score = 0;
      for (const m of g) score = Math.max(score, jaccard(it.tokens, m.tokens));
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (best && bestScore >= LINEAGE_SIM) best.push(it);
    else groups.push([it]);
  }

  return groups
    .filter((g) => g.length >= MIN_LINEAGE)
    .map((g) => {
      const renderIds = g.map((m) => m.r.id);
      let spine: Set<string> | null = null;
      for (const m of g) {
        if (spine === null) spine = new Set(m.tokens);
        else for (const t of [...spine]) if (!m.tokens.has(t)) spine.delete(t);
      }
      const steps: LineageStep[] = g.map((m, i) => {
        if (i === 0) return { renderId: m.r.id, added: [], removed: [] };
        const d = diffPrompts([...g[i - 1].tokens], [...m.tokens]);
        return { renderId: m.r.id, added: d.added, removed: d.removed };
      });
      return { id: renderIds[0], renderIds, spine: spine ? [...spine].sort() : [], steps, size: renderIds.length };
    })
    .sort((a, b) => b.size - a.size || b.id.localeCompare(a.id));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/promptLineage.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/creative/promptLineage.ts tests/promptLineage.test.ts
git commit -m "feat(lineage): promptLineage engine (greedy lineages + prompt/settings diff)"
```

---

### Task 2: `PromptLineage.tsx` + Craft view Insights | Lineage tab

**Files:**
- Create: `src/components/creative/PromptLineage.tsx`
- Modify: `src/components/creative/CraftInsights.tsx` (add the tab switch)
- Modify: `src/styles/creative.css` (append lineage styles)
- Test: `tests/craftBrain.test.ts` is unchanged; add a UI-less render smoke via the browser (Task 3).

**Interfaces:**
- Consumes: `buildLineages`, `diffPrompts`, `diffSettings`, `MAX_LINEAGES` (Task 1); `buildAnalysisContext`; store slices `gallery`/`creative.brains`/`shelf`; store actions `restoreSnapshot`, `promoteToRecipe`, `setView`; `Icon`.
- Produces: `<PromptLineage />`.

- [ ] **Step 1: Create `src/components/creative/PromptLineage.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useStudio, type GalleryItem } from '../../state/store';
import { buildAnalysisContext } from '../../state/creative';
import { buildLineages, diffPrompts, diffSettings, MAX_LINEAGES } from '../../core/creative/promptLineage';
import { tokenizePrompt } from '../../core/creative/craftBrain';
import { Icon } from '../icons';

function promptOf(item: GalleryItem): string {
  return item.manifest?.resolvedPrompt || item.manifest?.prompt || '';
}

export function PromptLineage() {
  const gallery = useStudio((s) => s.gallery);
  const brains = useStudio((s) => s.creative.brains);
  const shelf = useStudio((s) => s.shelf);
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot);
  const promoteToRecipe = useStudio((s) => s.promoteToRecipe);
  const [openId, setOpenId] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  const renders = useMemo(() => buildAnalysisContext(gallery, brains, shelf).renders, [gallery, brains, shelf]);
  const lineages = useMemo(() => buildLineages(renders), [renders]);
  const byId = useMemo(() => {
    const m = new Map<string, GalleryItem>();
    for (const g of gallery) m.set(g.id, g);
    return m;
  }, [gallery]);

  const shown = lineages.slice(0, MAX_LINEAGES);

  const toggleCompare = (id: string) => {
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 2 ? [c[1], id] : [...c, id]));
  };

  if (lineages.length === 0) {
    return (
      <section className="card creative-card"><p className="creative-empty">Not enough related renders yet — keep iterating on prompts and their evolution shows up here.</p></section>
    );
  }

  const [aId, bId] = compare;
  const aItem = aId ? byId.get(aId) : undefined;
  const bItem = bId ? byId.get(bId) : undefined;

  return (
    <>
      {lineages.length > MAX_LINEAGES ? (
        <p className="craft-note">Showing {MAX_LINEAGES} of {lineages.length} lineages (largest first).</p>
      ) : null}

      {aItem && bItem ? (
        <section className="card creative-card lineage-compare">
          <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} Compare</h3><span className="spacer" /><button className="btn tiny" type="button" onClick={() => setCompare([])}>Clear</button></div>
          <div className="lineage-compare-grid">
            <figure><img src={aItem.dataUrl} alt="A" /><figcaption>{promptOf(aItem).slice(0, 80)}</figcaption></figure>
            <figure><img src={bItem.dataUrl} alt="B" /><figcaption>{promptOf(bItem).slice(0, 80)}</figcaption></figure>
          </div>
          {(() => {
            const d = diffPrompts(tokenizePrompt(promptOf(aItem)), tokenizePrompt(promptOf(bItem)));
            const sd = diffSettings(
              renders.find((r) => r.id === aId)!,
              renders.find((r) => r.id === bId)!,
            );
            return (
              <div className="lineage-diff">
                {d.added.map((t) => <span key={`+${t}`} className="chip diff-add">+{t}</span>)}
                {d.removed.map((t) => <span key={`-${t}`} className="chip diff-rem">−{t}</span>)}
                {sd.map((s) => <span key={s.key} className="chip">{s.key} {s.from}→{s.to}</span>)}
              </div>
            );
          })()}
        </section>
      ) : (
        <p className="craft-note">Tip: click two thumbnails to compare them side-by-side.</p>
      )}

      <div className="lineage-list">
        {shown.map((ln) => {
          const items = ln.renderIds.map((id) => byId.get(id)).filter(Boolean) as GalleryItem[];
          if (items.length < 2) return null; // deleted renders collapsed the line
          const open = openId === ln.id;
          return (
            <section key={ln.id} className="card creative-card lineage-row">
              <div className="creative-card-head">
                <h3>{Icon.sparkle({ size: 14 })} {ln.spine.length ? ln.spine.slice(0, 4).join(', ') : 'Prompt line'}</h3>
                <span className="chip">{ln.size}</span>
                <span className="spacer" />
                {ln.spine.length ? <button className="btn tiny" type="button" onClick={() => promoteToRecipe({ text: ln.spine.join(', '), name: `Line: ${ln.spine.slice(0, 3).join(', ')}` })}>Make recipe</button> : null}
                <button className="btn tiny" type="button" onClick={() => setOpenId(open ? null : ln.id)}>{open ? 'Collapse' : 'Timeline'}</button>
              </div>
              <div className="lineage-strip">
                {ln.renderIds.map((id, i) => {
                  const it = byId.get(id);
                  if (!it) return null;
                  const step = ln.steps[i];
                  return (
                    <div key={id} className={`lineage-thumb ${compare.includes(id) ? 'sel' : ''}`}>
                      <button type="button" onClick={() => toggleCompare(id)} title="Click to compare">
                        <img src={it.dataUrl} alt={`step ${i + 1}`} />
                      </button>
                      {open && (step.added.length || step.removed.length) ? (
                        <div className="lineage-stepdiff">
                          {step.added.map((t) => <span key={`+${t}`} className="chip diff-add">+{t}</span>)}
                          {step.removed.map((t) => <span key={`-${t}`} className="chip diff-rem">−{t}</span>)}
                        </div>
                      ) : null}
                      {open ? (
                        <button className="btn tiny" type="button" onClick={() => restoreSnapshot(it)}>Restore</button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add the Insights | Lineage tab to `CraftInsights.tsx`**

Add the import near the top:

```tsx
import { PromptLineage } from './PromptLineage';
```

Add a tab state at the top of the `CraftInsights` component (with the other `useState`/selectors):

```tsx
  const [tab, setTab] = useState<'insights' | 'lineage'>('insights');
```

Immediately after the closing `</header>` (line ~60), insert the tab bar:

```tsx
        <div className="craft-tabs">
          <button className={`btn tiny ${tab === 'insights' ? 'primary' : ''}`} type="button" onClick={() => setTab('insights')}>Insights</button>
          <button className={`btn tiny ${tab === 'lineage' ? 'primary' : ''}`} type="button" onClick={() => setTab('lineage')}>Lineage</button>
        </div>
        {tab === 'lineage' ? <PromptLineage /> : (
```

Then find the existing content block that starts with `{report.palette.length === 0 ? (` and wrap it: it becomes the `tab === 'insights'` branch. Close the wrapper right before the `</div>` that closes `studio-page-inner` (the `</main>`), i.e. change the tail:

```tsx
          </>
        )}
        )}
      </div>
    </main>
```

(The first `</>)}` closes the existing `palette.length === 0 ? ... : (<>...</>)` ternary as before; the added `)}` closes the new `tab === 'lineage' ? … : ( … )` wrapper. Verify the JSX balances with `npm run typecheck`.)

- [ ] **Step 3: Append lineage styles to `src/styles/creative.css`**

```css
/* Prompt Lab — lineage tab */
.craft-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.lineage-list { display: flex; flex-direction: column; gap: 12px; }
.lineage-strip { display: flex; gap: 10px; overflow-x: auto; padding: 4px 0; }
.lineage-thumb { display: flex; flex-direction: column; gap: 4px; align-items: center; flex: 0 0 auto; width: 96px; }
.lineage-thumb > button { padding: 0; border: 2px solid transparent; border-radius: 8px; background: none; cursor: pointer; }
.lineage-thumb.sel > button { border-color: var(--accent, #7aa2ff); }
.lineage-thumb img { width: 92px; height: 92px; object-fit: cover; border-radius: 6px; display: block; }
.lineage-stepdiff { display: flex; flex-wrap: wrap; gap: 3px; justify-content: center; }
.lineage-diff { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.lineage-compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lineage-compare-grid img { width: 100%; border-radius: 8px; }
.lineage-compare-grid figcaption { font-size: 11px; opacity: 0.7; }
.chip.diff-add { color: #6ee7a8; }
.chip.diff-rem { color: #ff9b9b; }
```

- [ ] **Step 4: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — no type errors; all suites green (including `promptLineage` + the existing craft/route tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/creative/PromptLineage.tsx src/components/creative/CraftInsights.tsx src/styles/creative.css
git commit -m "feat(lineage): Prompt Lab — Lineage tab in the Craft view (timelines + compare)"
```

---

### Task 3: Version bump + verify + PR

**Files:** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`

- [ ] **Step 1: Bump to 0.28.0** (all four; Read `Cargo.lock`'s `lumendeck` block then Edit).

- [ ] **Step 2: Verify**

Run: `npx vitest run tests/versionSync.test.ts && npm run typecheck && npx vitest run && npm run build`
Expected: versionSync PASS (all four == `0.28.0` == `APP_VERSION`); full suite green; typecheck clean; build succeeds.

- [ ] **Step 3: Browser smoke (best-effort)**

Start the dev server; open the Craft view; switch to the **Lineage** tab. With a demo/seeded gallery confirm: lineage rows render with thumbnail strips; clicking "Timeline" shows step diffs; clicking two thumbnails shows the compare with prompt+settings diff; the empty state shows with a thin gallery. If the Chrome bridge is unavailable in this environment, note it and rely on the unit suite. Capture a screenshot if possible.

- [ ] **Step 4: Commit + push + PR**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump to v0.28.0 (creative intelligence phase 2 — prompt lab)"
git push -u origin feature/creative-intelligence-p2
gh pr create --base feature/creative-intelligence-p1 --title "Creative Intelligence — Phase 2: Prompt Lab / lineage (v0.28.0)" --body "$(cat <<'EOF'
Prompt Lab: trace how a prompt evolved across your renders.

- Pure `promptLineage` engine: greedy-by-time Jaccard clustering (over Phase-1 `tokenizePrompt`)
  into time-ordered prompt lineages with a shared `spine` + per-step token diffs; `diffPrompts`
  / `diffSettings` for compare. Deterministic, honesty-gated.
- New **Lineage** tab in the Craft view (Insights | Lineage): thumbnail timelines with inline
  step diffs, expand a line, and side-by-side compare of any two renders. Reuses
  `restoreSnapshot` + `promoteToRecipe`.
- Phase 2 of Creative Intelligence. **Stacks on #40** (imports craftBrain) — merge after it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Base the PR on `feature/creative-intelligence-p1` so the diff is only Phase 2. If #40 is already merged to main by then, base on `main` instead.)

Do NOT cut a public MSI release until the user explicitly says "release".

---

## Notes for the executor

- The Craft-view tab wrap in Task 2 Step 2 is the fiddly part: read `CraftInsights.tsx` first, wrap the existing content block in the `tab === 'insights'` branch, and confirm JSX balances via `npm run typecheck` before moving on.
- `promptLineage` reuses `tokenizePrompt` from `craftBrain.ts` (same branch) — do not duplicate the tokenizer.
- Keep the engine pure; all lineage correctness is unit-tested. The panel is derived rendering; the browser smoke covers wiring.
- Zustand rule: `PromptLineage` subscribes to slices + `useMemo` — never `useStudio((s) => s.someGetter())`.
