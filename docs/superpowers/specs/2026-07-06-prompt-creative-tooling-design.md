# LumenDeck — Prompt & Creative Tooling (2026-07-06, Sub-project C)

A local-first creative layer around the prompt: a **Prompt Studio** panel with four cooperating
tools — **Library/Presets**, **Wildcards + Variations**, **History/Favorites**, and a **rule-based
Prompt Enhancer** (with a seam for a future cloud LLM). All offline, all deterministic, no account.
Approved via brainstorming (user: "all of the above"). Assistant decision: ship the heuristic
enhancer now; leave a typed seam for an optional cloud LLM (the providers Codex is building).

## Design principles
- **Pure core, thin UI.** Each tool is a pure, independently-tested module under `src/core/prompt/`;
  the UI and a persisted store slice consume them. No React or fetch in core.
- **Reproducible.** Wildcard expansion is seeded by the render seed and the *resolved* prompt is
  recorded in the manifest + history, so any render can be reproduced exactly.
- **Bounded local state.** Presets/wildcards/history persist via the existing Zustand-persist
  mechanism (same as workflow persistence); history is capped.

## Core modules (`src/core/prompt/`)
- **`presets.ts`** — `PromptPreset = { id, name, positive, negative, tags?, settings?: {steps?, cfg?,
  sampler?, scheduler?}, builtin?: boolean, createdAt }`. CRUD helpers + `STARTER_PRESETS` (~10
  curated: cinematic photo, portrait photoreal, anime, watercolor, 3D render, product shot, pixel
  art, comic ink, cyberpunk, oil painting) seeded on first run and flagged `builtin` (restorable,
  not permanently deletable-by-accident — deleting a builtin just hides it).
- **`wildcards.ts`** — `WildcardSet = { name, values: string[], builtin?: boolean }`. Built-ins:
  `color, lighting, mood, camera, style, material`. `expandWildcards(text, sets, rng) ->
  { resolved, used: {token,value}[] }`: replaces every `__name__` with a seeded pick; unknown
  tokens pass through untouched (and are reported so the UI can warn). Nested tokens resolved one
  pass (documented limit). RNG is a small seeded PRNG (mulberry32) keyed by the render seed for
  determinism.
- **`variations.ts`** — `planVariations({base, axis, count})` where axis ∈ `seed | cfg | steps |
  wildcard`. Returns `count` `RenderJob`-patch objects (e.g. seed+i, cfg sweep across a range, or
  a distinct wildcard value each). Pure planning only; execution reuses the existing
  `enqueueBatch`/`enqueueRender` path.
- **`history.ts`** — `PromptHistoryEntry = { id, positive, negative, resolved?, seed, modelId?, at,
  favorite }`. `record(list, entry, cap=500)` (dedups consecutive identical prompts, trims to cap
  keeping all favorites), `toggleFavorite`, `search(list, query)` (substring over positive/negative,
  favorites-first ordering option).
- **`enhance.ts`** — `enhancePrompt(text, opts) -> { positive, negativeAdditions, notes[] }`, a pure
  rule-based enhancer: appends quality/detail tags by detected subject (portrait→skin/eyes detail;
  landscape→depth/atmosphere; generic→"sharp focus, detailed"), proposes standard negatives
  (blurry, lowres, extra fingers…), normalizes weight syntax (`(x:1.2)`), and de-dups tags. Idempotent
  (running twice adds nothing new). Plus `PromptAssistant` interface with `HeuristicAssistant`
  (this module) as the default impl and a documented `CloudAssistant` seam that will POST to the
  bridge `/cloud/*` route (Codex's work) when a provider key exists — NOT built here, just the type.

## Store & data flow
- New persisted slice `promptTools`: `{ presets, wildcardSets, history }` + actions: `savePreset`,
  `applyPreset` (writes positive/negative and optional settings into the prompt/sampler capsules),
  `deletePreset`, `upsertWildcardSet`, `deleteWildcardSet`, `recordHistory`, `toggleFavorite`,
  `enqueueVariations(axis,count)`.
- **buildRenderJob**: after reading the prompt, run `expandWildcards` seeded by the resolved seed;
  send the resolved text as the job prompt; attach `resolvedPrompt` + `usedWildcards` for the
  manifest.
- **enqueueRender**: on each successful enqueue, `recordHistory` with the resolved prompt + seed +
  modelId. (One entry per render; favorites survive the cap.)
- **Manifest**: add `resolvedPrompt` + `wildcards: [{token,value}]` so a saved image documents the
  exact text that made it.

## UI — Prompt Studio
A collapsible **Prompt Studio** section attached to the Prompt capsule area (reuses existing panel/
inspector styling and the LoRA/ControlNet rack visual language), with four tabs:
- **Library** — grid of preset cards (name + swatch/tag); click applies; "Save current as preset"
  captures positive/negative (+ optional settings toggle); rename/delete; builtin badge.
- **Wildcards** — list of sets with editable value lists; a "Preview expansion" that shows a sample
  resolved prompt; unknown-token warnings.
- **History** — reverse-chronological list, star toggles, search box, "Load" restores a prompt
  (and seed) into the composer; favorites filter.
- **Enhance** — one-click "Enhance prompt" runs the heuristic, shows a diff (added tags + proposed
  negatives) the user can accept/undo; a disabled "Use AI model (connect a cloud key)" affordance
  documents the future seam.
Keep the standing a11y bar: labels, roles, focus rings, reduced-motion, AA contrast.

## Testing & verification
- **Pure unit tests (vitest)** — the heart of the verification: `expandWildcards` (seeded
  determinism: same seed→same resolution; unknown-token passthrough+report; nested one-pass);
  preset CRUD + starter seeding + builtin-hide; `planVariations` for each axis (correct count,
  correct varied field, cfg range bounds); `history.record` (cap trims non-favorites, keeps
  favorites, dedups consecutive), `search`, `toggleFavorite`; `enhancePrompt` (subject detection,
  idempotence, weight normalization, negative proposals); `buildRenderJob` wildcard resolution +
  manifest fields; store actions (applyPreset writes capsules, recordHistory on enqueue).
- **Preview smoke** — Prompt Studio renders, tab switching, apply/enhance/load round-trips
  (preview_* against the dev server).
- All existing tests stay green (currently 104 vitest, 50 pytest, tsc clean). No GPU needed —
  this sub-project is entirely frontend/core, so it is fully verifiable offline.

## Acceptance
1. Save the current prompt as a preset, reload the app, apply it → composer repopulates.
2. A prompt with `__style__, __lighting__` renders a concrete image; the manifest shows the
   resolved text; re-rendering with the same seed resolves identically.
3. "Variations ×4 by seed" enqueues 4 renders differing only by seed; "by cfg" sweeps CFG.
4. Every render appears in History; starring keeps it past the 500 cap; Load restores it.
5. "Enhance" adds sensible tags/negatives, is idempotent, and is fully undoable.
6. Existing capsules, backends, and all tests remain green.
