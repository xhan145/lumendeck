# Creative Intelligence — Phase 3 (Prompt Coach) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Prompt Coach" that, while you compose a prompt, proactively suggests high-lift tokens, the lineage your prompt resembles, and a matching recipe — each one-click and append-only — as a new tab in PromptStudio.

**Architecture:** A pure `promptCoach.ts` engine reads the current positive prompt and reuses Phase 1 (`analyzeCraft` working tokens) + Phase 2 (`buildLineages` spines) + recipes to rank `CoachSuggestion[]`. A new "Coach" tab in `PromptStudio.tsx` derives them with `useMemo` and applies them append-only via the store's `updateParam` / `applyCreativeRecipe`.

**Tech Stack:** TypeScript, React 18, Zustand, Vite 6, Vitest.

## Global Constraints

- **Version target:** bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` to **0.29.0** (`tests/versionSync.test.ts` guards parity with `APP_VERSION`).
- **Depends on Phase 1 + 2:** this branch stacks on `feature/creative-intelligence-p2` (PR #42, itself on #40). It imports `analyzeCraft`/`tokenizePrompt`/`CraftReport` from `craftBrain.ts` and `buildLineages`/`PromptLineage`/`tokenJaccard` from `promptLineage.ts`.
- **Pure engine:** `promptCoach.ts` is deterministic, never throws, no store/ML — mirrors the house engine style.
- **Each source self-gates (no blanket gate):** add-token draws from `craftReport.working` (empty until P1 is ready); apply-line needs a real lineage; apply-recipe needs a match. `coach()` returns `[]` when nothing fires → honest empty state.
- **Append-only apply:** never overwrite the current prompt; comma-join, trimmed.
- **Zustand rule:** never a getter-in-selector; subscribe to slices + `useMemo`.
- **No public MSI release** until the user explicitly says "release".

---

### Task 1: `promptCoach.ts` engine (+ export `tokenJaccard`) + tests

**Files:**
- Modify: `src/core/creative/promptLineage.ts` (rename the private `jaccard` → exported `tokenJaccard`)
- Create: `src/core/creative/promptCoach.ts`
- Test: `tests/promptCoach.test.ts`

**Interfaces:**
- Consumes: `tokenizePrompt`, `CraftReport` (has `working: CraftInsight[]` where `CraftInsight = { kind; label; lift; ... }`); `PromptLineage` (`spine: string[]`); `tokenJaccard(a: Set<string>, b: Set<string>): number`; `CreativeRecipe` (`id`, `name`, `promptTemplate`).
- Produces:
  - `interface CoachSuggestion { kind: 'add-token'|'apply-line'|'apply-recipe'; label: string; reason: string; tokens: string[]; recipeId?: string }`
  - Constants `MAX_TOKEN_SUGGESTIONS = 5`, `COACH_SIM = 0.3`.
  - `coach(currentPrompt: string, craftReport: CraftReport, lineages: PromptLineage[], recipes: CreativeRecipe[]): CoachSuggestion[]`
  - `appendTokens(current: string, tokens: string[]): string` (the append-only apply helper).

- [ ] **Step 1: Export `tokenJaccard` from `promptLineage.ts`**

In `src/core/creative/promptLineage.ts`, change the private helper to an exported one and update its call site:

```ts
export function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
```

Inside `buildLineages`, replace the two `jaccard(` calls with `tokenJaccard(`.

- [ ] **Step 2: Write the failing tests**

Create `tests/promptCoach.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/promptCoach.test.ts`
Expected: FAIL — cannot resolve `promptCoach`.

- [ ] **Step 4: Implement `src/core/creative/promptCoach.ts`**

```ts
/**
 * Prompt Coach: proactive, append-only prompt suggestions from the user's own craft
 * history — high-lift tokens (Phase 1), the lineage the current prompt resembles
 * (Phase 2), and a matching recipe. Pure + deterministic; each source self-gates so it
 * stays silent (and honest) on thin data. Mirrors the house engine style.
 */
import type { CraftReport } from './craftBrain';
import { tokenizePrompt } from './craftBrain';
import type { PromptLineage } from './promptLineage';
import { tokenJaccard } from './promptLineage';
import type { CreativeRecipe } from './types';

export const MAX_TOKEN_SUGGESTIONS = 5;
export const COACH_SIM = 0.3;

export interface CoachSuggestion {
  kind: 'add-token' | 'apply-line' | 'apply-recipe';
  label: string;
  reason: string;
  /** tokens this suggestion appends (add-token: 1; apply-line: the missing spine tokens; apply-recipe: []) */
  tokens: string[];
  recipeId?: string;
}

/** Append-only apply: comma-join `tokens` onto `current`, trimmed; seeds a blank prompt. */
export function appendTokens(current: string, tokens: string[]): string {
  const added = tokens.join(', ');
  if (!added) return current;
  const base = current.trim();
  return base ? `${base}, ${added}` : added;
}

export function coach(currentPrompt: string, craftReport: CraftReport, lineages: PromptLineage[], recipes: CreativeRecipe[]): CoachSuggestion[] {
  const currentTokens = new Set(tokenizePrompt(currentPrompt));
  const out: CoachSuggestion[] = [];

  // add-token: high-lift working tokens (already lift-ranked by analyzeCraft) not present.
  for (const w of craftReport.working) {
    if (w.kind !== 'token' || currentTokens.has(w.label)) continue;
    out.push({ kind: 'add-token', label: w.label, reason: `${w.lift}× in your kept work`, tokens: [w.label] });
    if (out.filter((s) => s.kind === 'add-token').length >= MAX_TOKEN_SUGGESTIONS) break;
  }

  // apply-line: the best-matching lineage spine with >= 1 missing token.
  let bestLine: { ln: PromptLineage; score: number; missing: string[] } | null = null;
  for (const ln of lineages) {
    if (ln.spine.length === 0) continue;
    const score = tokenJaccard(currentTokens, new Set(ln.spine));
    if (score < COACH_SIM) continue;
    const missing = ln.spine.filter((t) => !currentTokens.has(t));
    if (missing.length > 0 && (!bestLine || score > bestLine.score)) bestLine = { ln, score, missing };
  }
  if (bestLine) {
    const head = bestLine.ln.spine.slice(0, 3).join(', ');
    out.push({ kind: 'apply-line', label: head, reason: `looks like your "${head}" line`, tokens: bestLine.missing });
  }

  // apply-recipe: the best-overlapping recipe.
  let bestRecipe: { r: CreativeRecipe; score: number } | null = null;
  for (const r of recipes) {
    const score = tokenJaccard(currentTokens, new Set(tokenizePrompt(r.promptTemplate)));
    if (score >= COACH_SIM && (!bestRecipe || score > bestRecipe.score)) bestRecipe = { r, score };
  }
  if (bestRecipe) {
    out.push({ kind: 'apply-recipe', label: bestRecipe.r.name, reason: 'a recipe that matches this prompt', tokens: [], recipeId: bestRecipe.r.id });
  }

  return out;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/promptCoach.test.ts tests/promptLineage.test.ts && npm run typecheck`
Expected: PASS (promptCoach + the existing promptLineage tests still green after the `tokenJaccard` rename); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/creative/promptLineage.ts src/core/creative/promptCoach.ts tests/promptCoach.test.ts
git commit -m "feat(coach): promptCoach engine (token/line/recipe suggestions) + export tokenJaccard"
```

---

### Task 2: "Coach" tab in `PromptStudio`

**Files:**
- Modify: `src/components/prompt/PromptStudio.tsx` (Tab union, TABS, panel switch, new `CoachTab`)
- Modify: `src/styles/*` (append `.ps-coach` styles — same stylesheet PromptStudio uses; grep `.ps-tab` to find it)

**Interfaces:**
- Consumes: `coach`, `appendTokens`, `type CoachSuggestion` (Task 1); `analyzeCraft` (craftBrain), `buildLineages` (promptLineage), `buildAnalysisContext` (state/creative); store `workflow`/`updateParam`/`applyCreativeRecipe`/`gallery`/`creative`/`shelf`; `findNode` (already imported in PromptStudio).

- [ ] **Step 1: Add the imports + the `'coach'` tab to `PromptStudio.tsx`**

Add near the top imports:

```tsx
import { buildAnalysisContext } from '../../state/creative';
import { analyzeCraft } from '../../core/creative/craftBrain';
import { buildLineages } from '../../core/creative/promptLineage';
import { coach, appendTokens, type CoachSuggestion } from '../../core/creative/promptCoach';
```

Extend the `Tab` union and `TABS`:

```tsx
type Tab = 'library' | 'wildcards' | 'history' | 'enhance' | 'coach';

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'wildcards', label: 'Wildcards' },
  { id: 'history', label: 'History' },
  { id: 'enhance', label: 'Enhance' },
  { id: 'coach', label: 'Coach' },
];
```

Add the panel branch next to the others:

```tsx
            {tab === 'enhance' ? <EnhanceTab /> : null}
            {tab === 'coach' ? <CoachTab /> : null}
```

- [ ] **Step 2: Add the `CoachTab` component (in `PromptStudio.tsx`, next to the other *Tab components)**

```tsx
function CoachTab() {
  const workflow = useStudio((s) => s.workflow);
  const updateParam = useStudio((s) => s.updateParam);
  const applyCreativeRecipe = useStudio((s) => s.applyCreativeRecipe);
  const gallery = useStudio((s) => s.gallery);
  const brains = useStudio((s) => s.creative.brains);
  const recipes = useStudio((s) => s.creative.recipes);
  const shelf = useStudio((s) => s.shelf);

  const promptNode = findNode(workflow, 'prompt');
  const positive = String(promptNode?.params.positive ?? '');

  const suggestions = useMemo(() => {
    const renders = buildAnalysisContext(gallery, brains, shelf).renders;
    return coach(positive, analyzeCraft(renders, recipes, new Date()), buildLineages(renders), recipes);
  }, [positive, gallery, brains, shelf, recipes]);

  const apply = (s: CoachSuggestion) => {
    if (s.kind === 'apply-recipe' && s.recipeId) {
      applyCreativeRecipe(s.recipeId, positive);
      return;
    }
    if (!promptNode || s.tokens.length === 0) return;
    updateParam(promptNode.id, 'positive', appendTokens(positive, s.tokens));
  };

  if (suggestions.length === 0) {
    return <p className="field-help">Keep creating — suggestions appear here as your craft history grows.</p>;
  }
  return (
    <div className="ps-coach" role="list">
      {suggestions.map((s, i) => (
        <button key={`${s.kind}:${s.label}:${i}`} type="button" role="listitem" className={`ps-coach-item ${s.kind}`} onClick={() => apply(s)} title="Append to your prompt (never overwrites)">
          <span className="ps-coach-glyph" aria-hidden="true">{s.kind === 'add-token' ? '+' : s.kind === 'apply-line' ? '≈' : '▸'}</span>
          <span className="ps-coach-label">{s.label}</span>
          <span className="ps-coach-reason">{s.reason}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Append `.ps-coach` styles**

Find the stylesheet with `.ps-tab` (`grep -rl "\.ps-tab" src/styles`) and append:

```css
/* Prompt Coach tab */
.ps-coach { display: flex; flex-direction: column; gap: 6px; }
.ps-coach-item { display: grid; grid-template-columns: 18px auto 1fr; gap: 8px; align-items: center; text-align: left; padding: 6px 8px; border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 8px; background: none; cursor: pointer; color: inherit; }
.ps-coach-item:hover { border-color: var(--accent, #7aa2ff); }
.ps-coach-glyph { font-weight: 700; text-align: center; }
.ps-coach-item.add-token .ps-coach-glyph { color: #6ee7a8; }
.ps-coach-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ps-coach-reason { font-size: 11px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — no type errors; all suites green (including `promptCoach` + the renamed-jaccard `promptLineage` tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/prompt/PromptStudio.tsx src/styles
git commit -m "feat(coach): Prompt Coach tab in PromptStudio (append-only suggestions)"
```

---

### Task 3: Version bump + verify + PR

**Files:** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`

- [ ] **Step 1: Bump to 0.29.0** (all four; Read `Cargo.lock`'s `lumendeck` block then Edit).

- [ ] **Step 2: Verify**

Run: `npx vitest run tests/versionSync.test.ts && npm run typecheck && npx vitest run && npm run build`
Expected: versionSync PASS (all four == `0.29.0` == `APP_VERSION`); full suite green; typecheck clean; build succeeds.

- [ ] **Step 3: Browser smoke (best-effort)**

Start the dev server; open the graph/recipe workspace with PromptStudio; select the **Coach** tab. With a demo/seeded gallery + a prompt, confirm suggestions render and clicking one appends to the positive prompt (never overwrites); with a thin history, the honest empty state shows. If the Chrome bridge is unavailable in this environment, note it and rely on the unit suite. Capture a screenshot if possible.

- [ ] **Step 4: Commit + push + PR**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump to v0.29.0 (creative intelligence phase 3 — prompt coach)"
git push -u origin feature/creative-intelligence-p3
gh pr create --base feature/creative-intelligence-p2 --title "Creative Intelligence — Phase 3: Prompt Coach (v0.29.0)" --body "$(cat <<'EOF'
Proactive in-editor prompt suggestions from your own craft history — the Creative-Intelligence finale.

- Pure `promptCoach` engine: reads the current prompt and reuses Phase 1 (`analyzeCraft` high-lift
  tokens) + Phase 2 (`buildLineages` spines) + recipes to rank suggestions — add-token, resembles-a-line
  (append the missing spine tokens), apply-recipe. Each source self-gates (silent on thin data);
  deterministic; append-only apply helper.
- New **Coach** tab in PromptStudio (Library · Wildcards · History · Enhance · Coach): reactive to the
  live prompt; one-click **append-only** apply (never overwrites); honest empty state. Exports a shared
  `tokenJaccard` from `promptLineage`.
- Phase 3 of 3. **Stacks on #42 → #40** — merge in order (or rebase onto main once they land).

Verification: `promptCoach` fully unit-tested (token exclusion/cap/ordering, line-resemblance + missing-only,
recipe match, per-source gating, append-only, determinism). Full JS suite green, typecheck + build clean,
versionSync = 0.29.0. Browser smoke deferred (Chrome-extension bridge unavailable here); the engine is fully
tested and the tab is derived rendering.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do NOT cut a public MSI release until the user explicitly says "release".

---

## Notes for the executor

- `tokenJaccard` must be exported from `promptLineage.ts` and its old internal `jaccard(` call sites updated, or `buildLineages` breaks — run the promptLineage tests after the rename (Task 1 Step 5).
- `analyzeCraft` naturally leaves `working` empty until the corpus is ready (P1 gate), so add-token self-gates without any extra check — do not re-gate on `craftReport.ready`.
- Keep the engine pure; all correctness is unit-tested. The Coach tab is derived rendering; the browser smoke covers wiring.
- Zustand rule: `CoachTab` subscribes to slices + `useMemo` — never `useStudio((s) => s.someGetter())`.
