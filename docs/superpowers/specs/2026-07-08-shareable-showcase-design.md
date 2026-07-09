# Shareable Showcase — design spec

**Date:** 2026-07-08
**Status:** Approved (brainstorming)
**Scope:** Sub-project A of "Creative OS + sharing." This spec covers ONLY the
local-first, file-first **Showcase export**. Hosted share-links (Phase 2) and the
separate **Creative-OS-depth** sub-project are explicitly out of scope, tracked
for later specs.

## Problem

LumenDeck is a local-first desktop studio. A user can make a striking render or
video but has no first-class way to show it to another person *with the story of
how it was made*. Today the only export paths are a raw media download, a JSON
manifest, or the Creative-OS release-pack `.zip` (a launch-prep artifact, not a
viewable page). None of these is a "look what I made" that a non-user can just
open.

## Goal

One button that turns a render / collection / project into a **single
self-contained `.html` file** — the *Showcase* — that:

1. Opens in **any** browser with **no LumenDeck install** and **no network**
   (works offline, survives being emailed / DM'd / put on a USB stick).
2. Presents the media beautifully, on-brand (Midnight `#071426` / Ion Cyan
   `#34D6F4` / Voltage Violet `#7C3AED`, dark), and responsively.
3. Shows **how it was made**: prompt, model/recipe, key settings, seed, and a
   static SVG of the node "constellation."
4. **Embeds the `.lumen` project** so a LumenDeck user can click "Download
   `.lumen` → remix," while a non-user simply views. One artifact, widest reach.

Non-goals (this spec): uploading anything, hosted links, accounts, interactive
3D in the showcase, editing the showcase after export.

## Chosen approach

**Pure string-template generator** (Approach #1 of 3 considered). A pure TS module
assembles the HTML as a string — media inlined as `data:` URLs, CSS/JS inlined,
`.lumen` embedded as base64. This mirrors LumenDeck's existing pure-engine +
zero-dependency `zip.ts` patterns: deterministic, fully unit-testable, truly
self-contained, no new dependencies, local-first. (Rejected: React→static HTML —
app styles live in CSS files, self-containment gets messy, less testable. Bundle
a separate mini-viewer app — a second build artifact to maintain; a good *later*
layer for interactivity, overkill now.)

## Architecture

### New pure modules (`src/core/share/`)

- **`showcase.ts`** — `buildShowcaseHtml(input: ShowcaseInput): string`.
  Deterministic HTML assembly; no React, no DOM. The single source of the page.
  - `ShowcaseInput = { title: string; items: ShowcaseItem[]; provenance:
    ShowcaseProvenance; lumen?: LumenEmbed; options?: ShowcaseOptions }`.
  - `ShowcaseItem = { dataUrl: string; mediaType: 'image' | 'video'; caption?:
    string }` (media already base64 `data:` URLs from the gallery).
  - `ShowcaseProvenance` = the display facts pulled from `ExportManifest`:
    `{ prompt, negativePrompt?, model?, seed?, params?: Record<string,string>,
    recipeName? }`.
  - `LumenEmbed = { base64: string; filename: string }` — the serialized `.lumen`
    JSON (from `buildLumenFile`), base64-encoded for embedding. Optional: absent
    ⇒ the remix button is omitted and a small "provenance only" note shown.
  - `ShowcaseOptions = { constellationSvg?: string; posterOnly?: boolean;
    footer?: boolean }`.
- **`showcaseSvg.ts`** — `renderConstellationSvg(graph, opts?): string`. Pure
  function that renders the workflow node graph to a static inline SVG (on-brand
  gradient orbs + wires), reused by the showcase. Extracted so the app and the
  showcase share one renderer rather than duplicating orb/wire drawing. If a full
  graph is unavailable, returns `''` and the showcase omits the panel.

### Reuse (no duplication)

- `src/core/lumenFile.ts` — `buildLumenFile(workflow, rackPresets, now)` builds the
  `LumenFile`; we `JSON.stringify` it → bytes → base64 for the embed. The showcase's
  inlined "Download `.lumen`" JS reconstructs the exact same JSON blob, so
  `parseLumenFile` round-trips it on re-import.
- `src/core/manifest.ts` — `ExportManifest` supplies `prompt`, `negativePrompt`,
  `model`, `seed`, resolved params (`sampler`, `canvas`, `loras`, `controlNets`),
  and — critically — **`graph: Workflow`**, the full workflow snapshot. Because the
  manifest already carries the complete graph, **every gallery render is
  remixable**: the `.lumen` embed is `buildLumenFile(manifest.graph, rackPresets,
  now)` and the constellation SVG renders `manifest.graph` directly. (`rackPresets`
  come from the live store; they are optional named bundles, not per-render, so an
  empty list is valid.)
- Gallery `GalleryItem.dataUrl` / `mediaType` supply the media, already base64.
- `src/bridge/exporter.ts` — add `downloadText(text, filename, mime)` next to the
  existing `downloadJson` / `downloadDataUrl` / `slugify`; save the showcase via a
  `text/html` Blob (browser download; Tauri uses the same anchor-download path the
  app already uses for JSON/media).

### UI entry points (thin wrappers only)

- **Gallery drawer** (`src/components/gallery/Gallery.tsx`, `drawer-actions`) — a
  **"Share"** button next to the existing download actions. Gathers the item +
  its manifest, builds the showcase for that single render, saves
  `<slug>.showcase.html`.
- **Creative-OS project** (`src/components/creative/ProjectsView.tsx`) — a "Share
  showcase" action that builds a multi-item showcase from the project's linked
  gallery renders + brain metadata (reuses the `RenderResolver` pattern already in
  `releasePack.ts`).

The wrappers only *gather → call `buildShowcaseHtml` → save*. All logic lives in
the pure modules.

## Data flow

```
GalleryItem(s) + ExportManifest + Workflow(+rackPresets)
        │
        ├─ media dataUrls ─────────────► ShowcaseItem[]
        ├─ manifest facts ─────────────► ShowcaseProvenance
        ├─ buildLumenFile → JSON → b64 ─► LumenEmbed        (when a workflow exists)
        └─ workflow graph ─────────────► renderConstellationSvg → options.constellationSvg
                        │
                        ▼
                buildShowcaseHtml(input) → self-contained HTML string
                        │
                        ▼
                downloadText(html, "<slug>.showcase.html", "text/html")
```

## Self-containment (hard rule)

- Every image/video is a `data:` URL; **all** CSS and the tiny toggle/remix JS is
  inlined; **zero** external requests (same discipline as a hosted Artifact).
- Enforced by a test that scans the output for external references: no
  `src="http`, `href="http`, `url(http`, `<link rel="stylesheet"`, or
  `<script src=` pointing off-document.

## Remix affordance

- The `.lumen` JSON is embedded as a base64 string in a `<script
  type="application/json">` block (not executed, just data).
- A "Download `.lumen`" button runs a few lines of inlined JS: base64 → Blob →
  anchor download of `<filename>.lumen`. Non-users ignore it; LumenDeck users get
  one-click remix. In the normal path the `.lumen` is always present (the manifest
  carries `graph`). Only in the edge case of a legacy manifest with an empty/absent
  `graph` is `lumen` omitted — then the button is dropped and a subtle "Provenance
  only — original project not embedded" line is shown (never a broken button).

## Error handling & guards

- **Missing media/manifest fields** → the relevant slot renders a labeled
  placeholder (mirroring `releasePack.ts`'s TODO-placeholder pattern); never a
  crash, never a silent omission.
- **Size guard** — base64 video can be large. If the assembled showcase would
  exceed **50 MB**, the builder returns a result flagged `oversized`, and the UI
  offers a **poster-only** mode (`options.posterOnly` → embed the still poster
  frame / first render instead of the video) rather than silently emitting a giant
  file. The threshold is a named constant.
- **Empty input** (no items) → throws a typed error the UI surfaces as a loud
  message; the showcase is never produced empty.
- Consistent with the project's "no silent placeholders / loud fallback" rule.

## Testing

Pure-module unit tests (Vitest), no DOM:

- `showcase.test.ts`:
  - media embedded as `data:` URLs; provenance fields rendered; recipe/model/seed
    present when supplied.
  - **`.lumen` round-trip**: embed a known `LumenFile` → extract the base64 from
    the output → decode → deep-equals the input (proves remix integrity).
  - **no external refs**: the output contains none of the off-document patterns
    above.
  - `posterOnly` swaps video for the poster; `oversized` flag fires past the size
    constant; missing-field slots render labeled placeholders; empty input throws.
  - footer toggle; title/slug escaping (HTML-escape user text — prompts/titles can
    contain `<`, `&`, quotes — a correctness + safety requirement).
- `showcaseSvg.test.ts`: nodes → circles + wires, on-brand gradient ids present,
  empty graph → `''`, deterministic output for a fixed graph.
- A thin UI smoke via existing component-test patterns is optional (the wrappers
  are trivial); the pure modules carry the coverage.

## Rollout

Single PR: pure modules + tests + exporter helper + two thin UI actions + CSS for
the Share button. Version bump to the next minor (**0.21.0**) since it's a new
user-facing capability. Ship behind no flag (additive, safe). Update
`docs/RELEASING.md` only if the release flow changes (it does not).

## Out of scope (tracked)

- **Hosted share-links** (Phase 2): publish → URL, needs a backend (Supabase
  precedent exists in `lumendeck-site`). Its own spec.
- **Creative-OS depth** sub-project (smarter next-action/critic, more recipe
  families): its own spec, brainstormed after this ships.
- Interactive 3D constellation in the showcase (Approach #3 layer).
