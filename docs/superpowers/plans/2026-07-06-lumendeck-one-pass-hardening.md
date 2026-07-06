# LumenDeck One-Pass Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LumenDeck's local render workflow understandable and trustworthy by adding real Controls, Settings, Diagnostics, and Performance pages, preserving fallback honesty, and documenting recovery paths.

**Architecture:** Promote existing rail/panel functionality into routeable pages and add small pure helpers for diagnostics, storage estimates, and render honesty. Preserve local-first browser storage while scaffolding the desktop filesystem path and keeping destructive actions confirmed.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Vite, Tauri, local Diffusers bridge, ComfyUI HTTP API.

---

### Task 1: Branch, Plan, and Baseline

**Files:**
- Create: `docs/superpowers/plans/2026-07-06-lumendeck-one-pass-hardening.md`

- [x] Create branch `codex/lumendeck-one-pass-hardening`.
- [x] Read the redteam brief and existing panels/pages before editing.
- [x] Track implementation checkpoints with the session plan.

### Task 2: Real Views and Navigation

**Files:**
- Modify: `src/state/store.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/shell/NavRail.tsx`
- Create: `src/pages/DiagnosticsPage.tsx`
- Create: `src/pages/PerformancePage.tsx`
- Test: `tests/store.test.ts`

- [ ] Extend `ViewId` and `VIEW_TITLES` with `diagnostics` and `performance`.
- [ ] Add nav entries in the required order: Guide, Recipe, Graph, Shelf, Gallery, Controls, Settings, Diagnostics, Performance.
- [ ] Make the rail scroll cleanly on short windows.
- [ ] Route Diagnostics and Performance pages from `App`.
- [ ] Add a store test proving every required view can be selected.

### Task 3: Controls and Settings Pages

**Files:**
- Modify: `src/pages/ControlsPage.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/styles/app.css`

- [ ] Put render, batch, queue, inspector, LoRA rack, health, backend CTA, and diagnostics CTA on Controls.
- [ ] Put backend selector, Comfy URL, bridge URL, bridge renderer, fallback warning, model/runtime state, CUDA/device status, and runtime actions on Settings.
- [ ] Add privacy/storage panels and confirmed destructive actions for local history/state reset.
- [ ] Keep existing backend actions wired to the store.

### Task 4: Diagnostics and Performance

**Files:**
- Create: `src/core/diagnostics.ts`
- Create: `src/core/storageStatus.ts`
- Create: `src/core/renderHonesty.ts`
- Create: `src/pages/DiagnosticsPage.tsx`
- Create: `src/pages/PerformancePage.tsx`
- Test: `tests/diagnostics.test.ts`
- Test: `tests/storageStatus.test.ts`
- Test: `tests/renderHonesty.test.ts`

- [ ] Format a redacted diagnostics report with app, backend, bridge, Comfy, Diffusers, CUDA, model folder, queue, and fallback state.
- [ ] Add Diagnostics actions: test backend, check/download/install model, refresh shelf/folder, open Settings/Controls, copy report.
- [ ] Add Performance view using TurboForge data, preset explanations, last plan/benchmark, timing categories, and measured-only speed language.
- [ ] Estimate browser gallery storage size and show storage mode/path scaffolding.

### Task 5: Fallback Honesty

**Files:**
- Modify: `src/core/manifest.ts`
- Modify: `src/state/store.ts`
- Modify: `src/components/gallery/Gallery.tsx`
- Modify: `src/components/queue/QueuePanel.tsx`
- Test: `tests/renderHonesty.test.ts`

- [ ] Add manifest metadata for selected backend, actual backend, fallback flag, fallback reason, and render mode.
- [ ] Preserve fallback data on gallery items and TurboForge manifest warnings.
- [ ] Mark queue jobs with `done_with_warning` when a fallback completed.
- [ ] Add Gallery card badges and drawer warning/details for fallback or procedural/mock renders.

### Task 6: Onboarding, Comfy Clarity, Storage, and Docs

**Files:**
- Modify: `src/components/guide/GuideView.tsx`
- Modify: `src/bridge/comfyAdapter.ts`
- Modify: `.gitignore`
- Modify: `README.md`
- Create: `docs/diagnostics.md`

- [ ] Update Guide with Quick demo, built-in Diffusers, ComfyUI, and scan-my-models paths.
- [ ] Improve ComfyUI endpoint/error copy and add workflow import/export placeholders where surfaced.
- [ ] Exclude generated model/runtime/gallery/cache files from git.
- [ ] Document new pages, fallback honesty, storage limitations, CUDA/Python/Torch troubleshooting, ComfyUI setup, and runtime repair status.

### Task 7: Validation, Commit, Merge, Push

**Commands:**
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git status --short`
- `git commit -m "Harden LumenDeck UX diagnostics and render honesty"`
- `git switch main`
- `git merge --no-ff codex/lumendeck-one-pass-hardening -m "Merge LumenDeck one-pass hardening"`
- `git push origin main`

- [ ] Fix all validation failures within repo control.
- [ ] Ensure no models, generated renders, runtimes, caches, `dist`, `target`, or `node_modules` are staged.
- [ ] Commit the branch.
- [ ] Merge with a merge commit into `main`.
- [ ] Push `main`, or report the precise auth/protection/upload failure and exact next action.
