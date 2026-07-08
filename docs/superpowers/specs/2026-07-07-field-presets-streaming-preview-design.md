# LumenDeck — Constellation Field Presets + Live Streaming Preview (2026-07-07)

Make the constellation a real parameter-navigation instrument: **10 curated, user-editable field
presets** that each map an orb/ghost's **X, Y, AND Z** position to distinct parameter bundles, and a
**debounced live streaming preview** that renders a fast low-res image as you move through the field
so you *watch* the output morph. Builds on the v0.16 Render-Space field/ghost system. Approved via
brainstorming: curated base set + user-editable · debounced live preview.

## Hard requirement: every preset uses all three axes
The v0.16 field auto-derived axes and could collapse toward one meaningful axis. Every builtin preset
here binds a NON-EMPTY bundle to **x, y, and z** — enforced by a pure validator + a test that fails
if any preset leaves an axis empty. The editor also requires all three axes before a custom preset
can be saved.

## Field presets — `src/core/field/presets.ts` (pure, tested)
- `AxisBundle = { label: string; params: { node: 'sampler'|'imageLoader'|'hiresFix'|'controlNetRack'|
  'loraRack'|'video'; param: string; min: number; max: number }[] }` — one axis → one or more params
  swept together (a "bundle").
- `FieldPreset = { id; name; description; builtin?: boolean; axes: { x: AxisBundle; y: AxisBundle;
  z: AxisBundle } }`.
- `BUILTIN_FIELD_PRESETS` — 10, each all-XYZ (params chosen to actually affect the render; per-model
  effectiveness is surfaced, see below):
  1. **Classic Sampler** — X Structure(cfg, steps) / Y Fidelity(denoise) / Z Variation(seed)
  2. **CFG Explorer** — X cfg / Y steps / Z seed
  3. **img2img Morph** — X Strength(imageLoader.strength) / Y cfg / Z seed
  4. **Detail & Upscale** — X hires scale / Y hires denoise / Z steps
  5. **ControlNet Balance** — X control strength / Y cfg / Z seed
  6. **LoRA Blend** — X mean LoRA weight / Y cfg / Z seed
  7. **Chaos** — X seed / Y cfg / Z steps (wide ranges for broad exploration)
  8. **Fine-Tune** — X cfg / Y steps / Z denoise (narrow ranges around current)
  9. **Motion** (video node) — X motionStrength / Y frameCount / Z fps
  10. **Hi-Fi Portrait** — X cfg / Y hires denoise / Z steps (portrait-leaning ranges)
- Helpers: `presetAxesUsed(p)` (asserts x+y+z non-empty), `applyPresetAxes(preset, pos {x,y,z 0..1},
  intensity) -> ParamPatch[]` (maps each normalized axis onto every param in its bundle, clamped),
  `fieldProfileFromPreset(preset)` so the existing orb gradient/ring + ghost drag consume presets
  through the SAME `applyField` path (a preset simply supplies the axes `fieldProfile` used to
  auto-derive). Deterministic; no fetch.
- **Effectiveness note (reuse the auto-evolve lesson):** a pure `inertParamsForModel(preset, modelId)`
  flags bound params the current model ignores (turbo → cfg pinned; sampler.denoise never read →
  img2img strength instead). The UI shows a small "X won't affect this model" hint; nothing silently
  does nothing.

## User-editable presets + persistence
- Store `field` slice gains `presets` (builtins seeded) + `activePresetId` + actions:
  `setActiveFieldPreset(id)`, `saveFieldPreset(name, axes)`, `updateFieldPresetAxis(id, axis, bundle)`,
  `deleteFieldPreset(id)` (builtins hide, not hard-delete). Persisted additively (mapping only;
  matches the promptTools/motion pattern; old blobs load).
- When a preset is active, `applyField` (ghost/orb → params) uses the preset's axes instead of the
  auto-derived profile; with no preset, current v0.16 behavior is unchanged.

## Live streaming preview — `src/core/field/preview.ts` + a controller
- `buildPreviewJob(workflow, presetPatches, { size=320, steps=4 }) -> RenderJob`: a fast, low-res
  variant of the current field-resolved params (turbo-friendly steps, small canvas) — a faithful
  miniature of what dropping the orb here would render.
- **Debounced streaming controller** (frontend): the ghost/orb drag feeds positions; when a position
  **settles ~150ms** a preview render fires via `adapter.generate` (low-res job). Each request gets a
  monotonic token; a newer position **supersedes** older in-flight results (stale results discarded —
  the render may still finish but is ignored), so the preview always reflects the latest position and
  the GPU is never queued more than ~1 deep. Feels near-live on 8 GB with sd-turbo (~320px, 4 steps
  ≈ sub-second).
- **StreamingPreview** panel: the latest preview image + the live field values (per-axis label +
  value) + a subtle "rendering…" state; a **"Render full"** button promotes the current position to a
  normal full-res gallery render. Mock backend → procedural preview (clearly placeholder); diffusers
  unavailable → loud "preview needs the bridge" note, never a fake image.
- No new bridge endpoint: previews reuse `generate` at low res. The controller lives beside the
  Graph3DView ghost-drag handlers; cancelled/torn down on unmount and when streaming is toggled off
  (a per-session toggle; off by default so no GPU runs unless asked).

## Testing & verification
- **Pure vitest**: all 10 builtins pass `presetAxesUsed` (x+y+z non-empty) — the headline guarantee;
  `applyPresetAxes` maps all three axes onto their bundle params with clamping; preset CRUD +
  builtin-hide + persistence round-trip; `inertParamsForModel` (turbo cfg, sampler denoise);
  `buildPreviewJob` (low res/steps, params from the active preset). Existing 494 tests stay green.
- **GPU (sd-turbo)**: a preview job (320px, 4 steps) renders in ~<1.5 s; two different field
  positions produce visibly different previews; superseding cancels stale results (no pile-up).
- **Browser smoke**: pick a preset → drag a ghost → preview updates as it settles; edit an axis in
  the editor → save a custom preset → it drives the field; "Render full" lands a gallery image.

## Acceptance
1. 10 presets, each mapping X, Y, and Z to real render params; switching presets re-labels the orb/
   ghost axes and changes what position controls.
2. Editing an axis and saving a custom preset works and persists; builtins can be restored.
3. With streaming on, moving an orb/ghost shows a live low-res preview that morphs as you navigate;
   superseding keeps it responsive; "Render full" promotes to a gallery render.
4. Inert params for the current model are flagged, never silently dead; no bridge → loud, no fake.
5. 494+ tests green; tsc clean; MSI builds + verifies (sidecar stays slim).
