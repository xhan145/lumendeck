# LumenDeck — Render-Space Ghost Controller (2026-07-06, v0.16.0)

Turn an orb's **3D position into a parameter controller** and its **equatorial ring into a value
dial**, without disturbing the graph layout — via a translucent "ghost" duplicate you fly through a
deterministic **render-space field**, drop **anchors** at sweet spots, and optionally **record its
path into a Motion clip**. This closes the Living Constellation loop: spatial control → recorded
animation → rendered video (Phases 1+2 already shipped). Approved via brainstorming.

## Honest framing (read first)
There is no trained model or telemetry in a local diffusion frontend, so the field is a
**deterministic, curated parameter-field**, NOT a learned latent space. "Adaptive" means the
axis→parameter mapping is chosen by rule from the node kind + model family (+ prompt markers). It
navigates like a latent space and is fully reproducible and unit-testable. No ML claims in code,
UI, or commit messages.

## 1. Render-space field (pure core, `src/core/field/`)
- **`fieldProfile.ts`** — `Bundle = { param: string; min: number; max: number }[]` (one axis can
  drive several correlated params). `FieldAxis = { label: string; bundle: Bundle }`.
  `FieldProfile = { x?: FieldAxis; y?: FieldAxis; z?: FieldAxis }`.
  `fieldProfile(nodeKind, family, params, promptText?) -> FieldProfile` picks up to 3 axes from a
  **curated per-kind table**, adapting ranges to family (SD1.5 vs SD2.1 vs SDXL) and prompt markers
  (e.g. "photo" biases the fidelity axis). Examples: sampler → X="Structure"(cfg,steps),
  Y="Fidelity"(denoise), Z="Variation"(seed); imageLoader → X="Adherence"(denoiseStrength);
  hiresFix → X="Detail"(scale,denoise); controlNetRack/loraRack → mean-strength bundles; generic
  fallback → first ≤3 numeric ParamDefs by their min/max. Nodes with no numeric params → empty
  profile (ghost disabled with a note). Pure + deterministic.
- **`applyField.ts`** — `applyField(pos: {x:number;y:number;z:number}, intensity: number, profile)
  -> MotionParamPatch[]` (reuses the existing `MotionParamPatch {nodeId,param,value}` shape). Each
  axis coord is normalized to [0,1]; `intensity∈[0,1]` scales displacement from each bundle's
  midpoint toward its ends; values clamped to [min,max]. Deterministic, unit-tested. Inverse
  helper `fieldPosition(values, profile)` (for restoring a ghost to saved values) rounds-trips.
- **The ring is a value dial (always on, no ghost required).** Dragging around an orb's equatorial
  ring sets that node's **primary value** (the same weight the gradient shows) across its range
  (0→360° = min→max), re-tinting the gradient live. This is the standalone "control values by the
  ring" capability; it works with or without a ghost. Ghost **intensity** is a SEPARATE control
  (a small handle/slider on the ghost) — the ring is never overloaded with intensity.

## 2. Ghost controller (state + 3D UI)
- **State slice `field`** (persisted via the existing mechanism; additive/optional so old saves
  load): `ghosts: Ghost[]`, `Ghost = { id, nodeId, pos:{x,y,z}, intensity, pinned, recording }`;
  `anchors: Anchor[]`, `Anchor = { id, nodeId, name, pos, values: MotionParamPatch[] }`.
- **Store actions:** `spawnGhost(nodeId)` (one per node; no-op if profile empty), `moveGhost(id,pos)`
  → `applyField` → write the node's params in ONE commit (gradient + ring re-tint; params feed
  `buildRenderJob`, so the real render reflects it), `setGhostIntensity(id,v)`, `pinGhost(id)`,
  `collapseGhost(id)` (removes the ghost; params stay where left), `saveAnchor(id,name)`,
  `restoreAnchor(anchorId)` (moves the ghost + sets values), `deleteAnchor(id)`.
- **3D UI (Graph3DView):** a ghost renders as a **translucent orb** offset from its origin orb, with
  faint **axis guides** labeled from the profile (e.g. "Structure →") and a live value chip.
  Dragging: pointer on the **ground plane** sets the two horizontal axes (X,Z) via the existing
  `pointerRayToPlane`; **Shift-drag** sets height (Y). The origin orb's **ring stays the primary-
  value dial** (§1); the ghost carries its own small **intensity** slider. As the ghost moves, the
  origin orb's gradient + ring re-tint to the resulting primary value. Ghost toolbar chips: Pin,
  Save anchor, Record, Collapse. Anchors render as small clickable
  markers; clicking restores. A one-line note: "Ghost drives generation values by position;
  intensity = ring. Not a trained model — a curated field." Keep the a11y bar (keyboard: arrows
  nudge the ghost per-axis, Enter saves an anchor, Esc collapses).

## 3. Ghost path → Motion clip (included)
- A ghost's **Record** toggle samples its position on a fixed cadence (wall-clock, reuse the Motion
  Engine's starvation-safe stepper — NOT bare rAF) while you drag it; on stop it converts the
  sampled path into a **MotionClip**: one track per field-mapped param, keyframes at the sampled
  times (via the existing motion slice `addTrack`/`addKeyframe`), then sets it active. The clip
  then plays (Phase 1) and renders (Phase 2) unchanged — spatial performance becomes a rendered
  animation. Pure conversion `pathToClip(samples, profile, nodeId) -> MotionClip` is unit-tested;
  the store action wires it to the motion slice.

## Testing & verification
- **Pure unit (vitest):** `fieldProfile` per-kind/family/prompt selection (deterministic, empty for
  no-numeric nodes); `applyField` (position→patches, intensity 0 = midpoint, 1 = full range, clamps)
  + `fieldPosition` round-trip; anchor save/restore; `pathToClip` (N samples → correct tracks +
  keyframe count/times/values). All existing 334 tests stay green; tsc clean.
- **Browser smoke:** spawn a ghost from the sampler orb; ground-drag + shift-drag change its params
  (gradient/ring update live); ring-drag changes intensity; save an anchor then restore it; Record a
  short drag → a Motion clip appears and plays. No console errors; graph layout unchanged; 2D view
  untouched.
- **GPU:** not required (params flow through the proven `buildRenderJob`/render path); a motion
  render of a recorded ghost path is covered by Phase 2's verified pipeline.

## Acceptance
1. The equatorial ring is a working dial (drag = intensity), and the gradient re-tints as values
   change.
2. Spawning a ghost and moving it in 3D sets the node's parameters by position (curated field);
   the original orb and graph layout are untouched.
3. Anchors save/restore discovered sweet spots.
4. Recording a ghost's path produces a playable Motion clip (which renders via Phase 2).
5. No workflow schema change; old saves load; 334+ tests green; tsc clean; MSI builds ~≤16MB.
