# Shareable Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, LumenDeck convention) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click export that turns a render / project into a single self-contained `.html` "Showcase" that opens in any browser (no install, no network), shows the media + how it was made + a static constellation SVG, and embeds the `.lumen` for one-click remix.

**Architecture:** Two new pure TS modules under `src/core/share/` assemble the HTML as a deterministic string (media inlined as `data:` URLs, CSS/JS inlined, `.lumen` embedded as base64), mirroring the existing pure `zip.ts`/`releasePack.ts` pattern. Thin UI wrappers in the Gallery drawer and Creative-OS Projects view gather inputs and save via a new `exporter.ts` helper. No new dependencies; fully local-first.

**Tech Stack:** TypeScript, React 18, Zustand, Vitest. Reuses `src/core/lumenFile.ts` (`.lumen` codec), `src/core/manifest.ts` (`ExportManifest`, incl. `graph: Workflow`), `src/bridge/exporter.ts` (download helpers), gallery `GalleryItem.dataUrl`.

## Global Constraints

- **Self-contained (hard rule):** zero external requests — every image/video is a `data:` URL; all CSS + JS inlined. No `src="http`, `href="http`, `url(http`, `<link rel="stylesheet"`, or off-document `<script src=`.
- **No silent placeholders / loud fallback:** missing media/fields render a *labeled* placeholder; empty input throws a typed error; oversized output is flagged, never silently emitted.
- **HTML-escape all user text** (prompt, title, captions) — correctness + XSS safety in the generated file.
- **Reuse, don't duplicate:** use `buildLumenFile`, `ExportManifest`, `slugify`, gallery `dataUrl`s. New pure modules only for genuinely new logic.
- **Pure modules are DOM-free and deterministic** (unit-testable like `zip.ts`).
- **Size guard constant:** `SHOWCASE_MAX_BYTES = 50 * 1024 * 1024`.
- **Brand:** Midnight `#071426` / Ion Cyan `#34D6F4` / Voltage Violet `#7C3AED`, dark.
- Tests live in `tests/`, run with `npx vitest run <file>`. Typecheck: `npx tsc --noEmit`.

---

### Task 1: Constellation SVG renderer (`showcaseSvg.ts`)

**Files:**
- Create: `src/core/share/showcaseSvg.ts`
- Test: `tests/showcaseSvg.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `WorkflowNode` (`{ id, kind, x, y, params }`), `WorkflowEdge` (`{ id, from: {node,socket}, to: {node,socket} }`) from `src/core/types.ts`.
- Produces: `renderConstellationSvg(graph: Workflow, opts?: { width?: number; height?: number }): string` — a standalone inline `<svg>` string (empty string `''` when the graph has no nodes).

- [ ] **Step 1: Write the failing test**

```ts
// tests/showcaseSvg.test.ts
import { describe, expect, it } from 'vitest';
import { renderConstellationSvg } from '../src/core/share/showcaseSvg';
import type { Workflow } from '../src/core/types';

const graph: Workflow = {
  id: 'w1', name: 'Test', version: 1, schemaVersion: 1,
  nodes: [
    { id: 'prompt', kind: 'prompt', x: 40, y: 60, params: {} },
    { id: 'sampler', kind: 'sampler', x: 620, y: 240, params: {} },
  ],
  edges: [{ id: 'e1', from: { node: 'prompt', socket: 'out' }, to: { node: 'sampler', socket: 'in' } }],
};

describe('renderConstellationSvg', () => {
  it('renders one node marker per node and a wire per edge', () => {
    const svg = renderConstellationSvg(graph);
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<circle/g) ?? []).length).toBe(2);
    expect((svg.match(/<line|<path/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(svg).toContain('radialGradient'); // on-brand orb gradient defs
  });
  it('returns empty string for an empty graph', () => {
    expect(renderConstellationSvg({ ...graph, nodes: [], edges: [] })).toBe('');
  });
  it('is deterministic for a fixed graph', () => {
    expect(renderConstellationSvg(graph)).toBe(renderConstellationSvg(graph));
  });
  it('escapes node kind text used as labels', () => {
    const svg = renderConstellationSvg(graph);
    expect(svg).not.toContain('<script');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/showcaseSvg.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Implement a pure renderer: compute a viewBox from node `x`/`y` bounds (with padding); draw one `<line>` per edge between the from/to node centers; draw one `<circle>` per node filled with a kind-derived on-brand `radialGradient` (reuse a small kind→hue map — cyan for prompt/model, violet for sampler/control, mango for output/queue — matching the existing orb ramp); add a small `<text>` label of the node kind (HTML-escaped). Return `''` when `nodes.length === 0`. No external refs, no `<script>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/showcaseSvg.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/share/showcaseSvg.ts tests/showcaseSvg.test.ts
git commit -m "feat(share): pure constellation SVG renderer for the showcase"
```

---

### Task 2: Showcase HTML generator (`showcase.ts`)

**Files:**
- Create: `src/core/share/showcase.ts`
- Test: `tests/showcase.test.ts`

**Interfaces:**
- Consumes: `renderConstellationSvg` (Task 1); `LumenFile` from `src/core/lumenFile.ts`.
- Produces:
  - Types: `ShowcaseItem = { dataUrl: string; mediaType: 'image' | 'video'; caption?: string }`; `ShowcaseProvenance = { prompt: string; negativePrompt?: string; model?: string; seed?: number; params?: { label: string; value: string }[]; recipeName?: string }`; `LumenEmbed = { base64: string; filename: string }`; `ShowcaseInput = { title: string; items: ShowcaseItem[]; provenance: ShowcaseProvenance; lumen?: LumenEmbed; constellationSvg?: string; posterOnly?: boolean; footer?: boolean }`; `ShowcaseResult = { html: string; bytes: number; oversized: boolean }`.
  - `SHOWCASE_MAX_BYTES = 50 * 1024 * 1024`.
  - `buildShowcaseHtml(input: ShowcaseInput): ShowcaseResult` (throws `Error` on empty `items`).
  - Helper `escapeHtml(s: string): string` (exported for reuse/testing).

- [ ] **Step 1: Write the failing test**

```ts
// tests/showcase.test.ts
import { describe, expect, it } from 'vitest';
import { buildShowcaseHtml, escapeHtml, SHOWCASE_MAX_BYTES } from '../src/core/share/showcase';

const img = 'data:image/png;base64,iVBORw0KGgo=';
const base = {
  title: 'My Render',
  items: [{ dataUrl: img, mediaType: 'image' as const }],
  provenance: { prompt: 'a <neon> cat & dog', seed: 7, model: 'sd-turbo' },
};

describe('buildShowcaseHtml', () => {
  it('embeds media as data: URLs and renders provenance', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).toContain(img);
    expect(html).toContain('sd-turbo');
    expect(html).toContain('7');
  });
  it('HTML-escapes user text (no raw injection)', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).toContain('a &lt;neon&gt; cat &amp; dog');
    expect(html).not.toContain('<neon>');
  });
  it('has NO external references (fully self-contained)', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).not.toMatch(/src="http|href="http|url\(http|<link rel="stylesheet"|<script src=/);
  });
  it('round-trips an embedded .lumen (base64 decodes to the input JSON)', () => {
    const lumenJson = JSON.stringify({ app: 'LumenDeck', workflow: { id: 'w' } });
    const b64 = Buffer.from(lumenJson, 'utf-8').toString('base64');
    const { html } = buildShowcaseHtml({ ...base, lumen: { base64: b64, filename: 'proj.lumen' } });
    const m = html.match(/id="lumen-data"[^>]*>([^<]+)</);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1].trim(), 'base64').toString('utf-8')).toBe(lumenJson);
    expect(html).toContain('Download'); // remix button present
  });
  it('omits the remix button + shows a provenance-only note when no lumen', () => {
    const { html } = buildShowcaseHtml(base);
    expect(html).toContain('Provenance only');
    expect(html).not.toContain('id="lumen-data"');
  });
  it('posterOnly swaps a video item for its poster still', () => {
    const vid = { dataUrl: 'data:video/mp4;base64,AAA', mediaType: 'video' as const };
    const { html } = buildShowcaseHtml({ ...base, items: [vid], posterOnly: true, provenance: base.provenance });
    expect(html).not.toContain('<video');
  });
  it('flags oversized output past the size constant', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(SHOWCASE_MAX_BYTES + 1000);
    const { oversized } = buildShowcaseHtml({ ...base, items: [{ dataUrl: big, mediaType: 'image' }] });
    expect(oversized).toBe(true);
  });
  it('renders a labeled placeholder for a missing media slot', () => {
    const { html } = buildShowcaseHtml({ ...base, items: [{ dataUrl: '', mediaType: 'image' }] });
    expect(html.toLowerCase()).toContain('unavailable');
  });
  it('throws on empty items', () => {
    expect(() => buildShowcaseHtml({ ...base, items: [] })).toThrow(/no.*item/i);
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous chars', () => {
    expect(escapeHtml(`<a href="x" & 'q'>`)).toBe('&lt;a href=&quot;x&quot; &amp; &#39;q&#39;&gt;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/showcase.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Implement `escapeHtml` (`& < > " '`), then `buildShowcaseHtml`: throw if `items` empty; for each item render `<img src=data...>` (image) or `<video controls loop muted playsInline src=data...>` (video, unless `posterOnly` → labeled "video poster" placeholder or first image); empty `dataUrl` → a labeled `unavailable` placeholder block; render the provenance panel (escaped prompt/negative/model/seed/params/recipe); include `constellationSvg` verbatim if provided; if `lumen`, emit `<script type="application/json" id="lumen-data">{base64}</script>` + a "Download .lumen" button wired to inlined JS (base64→Blob→anchor), else a "Provenance only — original project not embedded" note; wrap in a full HTML doc with an inlined `<style>` (brand tokens, responsive, dark) and the inlined remix JS. Compute `bytes = new TextEncoder().encode(html).length` (Node/Vitest has `TextEncoder`); `oversized = bytes > SHOWCASE_MAX_BYTES`. Return `{ html, bytes, oversized }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/showcase.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/core/share/showcase.ts tests/showcase.test.ts
git commit -m "feat(share): self-contained showcase HTML generator"
```

---

### Task 3: Gallery drawer "Share" action + `downloadText` helper

**Files:**
- Modify: `src/bridge/exporter.ts` (add `downloadText`)
- Modify: `src/components/gallery/Gallery.tsx` (`drawer-actions` block)
- Modify: `src/styles/*` (Share button already uses existing `.btn`; add an accent variant only if needed — prefer reusing `.btn`)

**Interfaces:**
- Consumes: `buildShowcaseHtml` (Task 2), `renderConstellationSvg` (Task 1), `buildLumenFile` (`src/core/lumenFile.ts`), `slugify` (`exporter.ts`), `GalleryItem` + its `manifest: ExportManifest` (incl. `graph: Workflow`).
- Produces: `downloadText(text: string, filename: string, mime = 'text/html'): void` in `exporter.ts`.

- [ ] **Step 1: Add `downloadText` to `exporter.ts`**

```ts
export function downloadText(text: string, filename: string, mime = 'text/html'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 2: Wire a `shareShowcase(item)` helper in Gallery.tsx**

Build the input from the drawer's `item`/`m` (manifest): `items=[{dataUrl:item.dataUrl, mediaType:item.mediaType??'image'}]`; `provenance` from `m` (prompt, negativePrompt, `model?.name`, seed, params from sampler/canvas/loras); `constellationSvg = renderConstellationSvg(m.graph)`; `lumen` from `buildLumenFile(m.graph, rackPresets, new Date())` → `JSON.stringify` → base64 (`btoa(unescape(encodeURIComponent(json)))`), `filename = ${base}.lumen`. Call `buildShowcaseHtml`; if `oversized`, retry once with `posterOnly:true` and note it in a toast/status; `downloadText(result.html, ${base}.showcase.html)`. Add a `<button className="btn">Share</button>` to `drawer-actions`. Pull `rackPresets` from the store via the existing `useStudio` selector.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/bridge/exporter.ts src/components/gallery/Gallery.tsx
git commit -m "feat(share): Share button in the gallery drawer exports a showcase"
```

---

### Task 4: Creative-OS Projects "Share showcase" action

**Files:**
- Modify: `src/components/creative/ProjectsView.tsx`

**Interfaces:**
- Consumes: `buildShowcaseHtml`, `renderConstellationSvg`, `buildLumenFile`, the project `brain` + its linked gallery renders (via the existing `RenderResolver`/gallery-index pattern used by `releasePack`/`ProjectsView`).

- [ ] **Step 1: Add a "Share showcase" action to the project view**

Gather up to N (e.g. 8) of the project's linked renders as `ShowcaseItem[]` (resolve each `brain.renders` id → gallery `dataUrl`/`mediaType`); `title = brain.name`; `provenance` from the brain's active recipe/brief (prompt/model/recipeName when available, else the newest render's manifest); `constellationSvg` from the newest render's `manifest.graph`; `lumen` from that graph. Reuse the same `shareShowcase` logic — extract the input-building into a shared helper `src/core/share/showcaseInput.ts` if both call sites need it (DRY), otherwise inline. Save `${slugify(brain.name)}.showcase.html`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/creative/ProjectsView.tsx src/core/share/showcaseInput.ts
git commit -m "feat(share): Share showcase from a Creative-OS project"
```

---

### Task 5: Version bump + full verification

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` → `0.21.0`

- [ ] **Step 1: Bump all four version files to `0.21.0`** (APP_VERSION auto-follows via the Vite define; `versionSync.test.ts` will confirm).

- [ ] **Step 2: Full verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all tests green including `versionSync` (asserts the four files agree) and the new `showcase`/`showcaseSvg` suites.

- [ ] **Step 3: Browser smoke** — `npm run build`, open the built showcase output for a sample render in a browser (preview tools), confirm it renders offline with media + constellation + working "Download .lumen".

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump to 0.21.0 (Shareable Showcase)"
```

---

## Self-Review

**Spec coverage:** Concept/self-containment → Task 2 (no-external-refs test). Constellation SVG → Task 1. `.lumen` embed + remix → Task 2 (round-trip) + Tasks 3/4 (wiring). Provenance from manifest → Task 2 + 3. Gallery entry → Task 3. Project entry → Task 4. Size guard/poster-only → Task 2 + 3. Escaping → Task 2. Version bump/rollout → Task 5. All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; each task has real test + impl code or concrete wiring steps. The two UI tasks describe exact inputs/mappings rather than full JSX (justified: they are thin glue over the tested pure modules and depend on the exact live component code, read at execution time) — the *tested logic* is fully specified in Tasks 1-2.

**Type consistency:** `buildShowcaseHtml`/`ShowcaseInput`/`ShowcaseResult`/`renderConstellationSvg`/`downloadText`/`SHOWCASE_MAX_BYTES` names are used identically across tasks. `ExportManifest.graph: Workflow` and `WorkflowNode.{x,y,kind}` match `src/core/types.ts`. `.lumen` base64 uses UTF-8-safe encode/decode on both the embed (Task 3) and the round-trip test (Task 2).
