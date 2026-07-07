# LumenDeck — Motion Engine (Phase 1 of Living Constellation, v0.14.0)

The foundation of the [Living Constellation](2026-07-06-living-constellation-vision.md) loop: the
constellation **moves over a timeline**, orb motion + placement **encode values**, and value curves
are authored/played/scrubbed with interpolation. Ships a working vertical slice: schema →
interpolation → binding → playback → 3D motion → panel → persistence → render-plan stub → demo →
tests → docs. Approved to build autonomously in one pass (no per-section gate).

## Data model — `src/core/motion/types.ts`
```
EasingKind = 'linear'|'easeIn'|'easeOut'|'easeInOut'|'smoothstep'|'step'
Keyframe   = { t: number /* seconds, 0..duration */, value: number, easing?: EasingKind }
MotionTrack= { id, nodeId, param /* numeric ParamDef id on that node */, keyframes: Keyframe[] }
OrbMotion  = { style: 'orbit'|'bob'|'pulse'|'drift'|'still', speed: number, amplitude: number }
MotionClip = { id, name, duration /* s */, fps, loop: boolean, tracks: MotionTrack[],
               orbMotions: Record<nodeId, OrbMotion> }
MotionState (persisted slice) = { clips: MotionClip[], activeClipId: string|null }
```
- **Parameter binding model:** a track legally binds only to a numeric ParamDef of the node's
  capsule (validated via `CAPSULES[kind].params`, kind `'number'`); the param's `min/max` define
  the value domain. Helper `bindableParams(kind)` lists them; `isBindable(kind, param)` guards
  adds. Reuses v0.13's `orbWeight.primaryWeight` to suggest a default track per node.
- Motion vs value are two views: an orb's **value** comes from the bound track (if any) sampled at
  the playhead, else the live workflow param; its **spatial motion** comes from `OrbMotion`
  parameterized by that value (e.g., orbit radius ∝ value). No hidden duplicate state.

## Interpolation — `src/core/motion/interpolate.ts` (pure, the tested core)
- `EASING: Record<EasingKind,(x:number)=>number>` — unit-interval easing fns.
- `sampleTrack(track, t) -> number` — binary-search the surrounding keyframes, apply the *incoming*
  keyframe's easing across the segment; clamp to first/last value outside the range; empty track →
  null (caller falls back to the live param).
- `sampleClip(clip, t) -> Map<'nodeId:param', number>`.
- `clipValueForOrb(clip, node, t, liveValue) -> number` — the resolved value used for gradient/ring
  + motion.
- All deterministic and pure → no browser needed to test.

## Motion → 3D — `src/components/graph/graph3d/orbMotion.ts` (pure) + Graph3DView integration
- `motionOffset(orbMotion, valueT, t) -> {dx,dy,dz}` — pure position offset from the node's base
  world position: orbit (circle in XZ, radius = amp·valueT, angular speed = speed), bob (sine on Y),
  pulse (scale channel returned separately as `scale`), drift (slow lissajous), still (0). Selected/
  expanded node never moves (stays a card).
- Graph3DView: a **playback loop** (continuous rAF) runs ONLY while `playing`; each frame advances
  `t`, samples the active clip, updates orb positions (`base + motionOffset`), orb scale (pulse),
  and re-tints gradient/ring from the sampled value — reusing the v0.13 orb material/ring path.
  When `playing` flips false the loop cancels and the view returns to the v0.13 dirty-flag idle
  loop (via the existing flushScheduler). Wires follow moving orbs (endpoint recompute per frame
  while playing only). Reduced-motion: playback still works when explicitly pressed (it's an
  authoring action), but nothing auto-plays and ambient idle motion is off by default.

## Playback + store — `src/state/motion.ts` slice (added to the store)
State: `motion: MotionState` + transport `{ playing, t, playbackRate }` (transport is ephemeral/not
persisted; clips persist). Actions: `createClip`, `deleteClip`, `setActiveClip`, `addTrack(nodeId,
param)`, `removeTrack`, `addKeyframe(trackId, t, value)`, `updateKeyframe`, `removeKeyframe`,
`setClipDuration/Fps/Loop`, `setOrbMotion(nodeId, orbMotion)`, and transport `play/pause/stop/
seek(t)/setRate`. **Playback drives a preview only** — it does NOT commit sampled values into the
workflow store; a `bakeClipToWorkflow(atT)` action writes the sampled values into the capsule params
at a chosen time (explicit, undo-safe). `enqueueRender` is untouched in Phase 1.

## Persistence — `src/state/persistence.ts`
Add optional `motion?: MotionState` (additive; old saved state loads → seeded empty). Transport
state is never persisted. Follows the promptTools/graphMode migration pattern.

## Render-plan stub (the seam into Phase 2) — `src/core/motion/renderPlan.ts` (pure)
- `planMotionRender(clip, {frames}) -> MotionRenderFrame[]` where
  `MotionRenderFrame = { frame, t, paramPatches: {nodeId, param, value}[] }` — samples the clip at
  `frames` evenly-spaced times and emits per-frame param patches. This is fully implemented + tested
  now (pure), but **not yet wired to the bridge**; a documented `renderMotionClip()` adapter method
  throws `NotImplemented('Phase 2')`. Phase 2 turns each frame's patches into a RenderJob (reusing
  buildRenderJob + the AnimateDiff/batch path) and assembles the sequence. This keeps Phase 1
  honest (no fake renders) while proving the data path end-to-end in tests.

## UI — Motion Timeline panel — `src/components/motion/MotionTimeline.tsx`
Mounts in the 3D graph workspace (collapsible, like the palette) and on Controls. Contains:
- **Transport**: play/pause/stop, loop toggle, time readout `t / duration`, rate.
- **Scrubber**: a draggable playhead over the duration; dragging seeks (updates orbs live).
- **Track list**: each bound (node, param) row with a mini keyframe lane (dots at keyframe times,
  drag to move, click empty lane to add a keyframe at that time with the current sampled value),
  per-track easing select, remove. "Add track" → node + bindable-param picker.
- **Orb motion**: per-selected-node `OrbMotion` controls (style, speed, amplitude).
- a11y bar: labels, roles, focus, reduced-motion (transitions instant; no auto-play).

## Demo constellation
On first run seed one demo clip on the default workflow: 3s, loop, a track animating the Sampler
`cfg` 4→18→7 (three keyframes, easeInOut) and orbit `OrbMotion` on a few nodes — so pressing Play
immediately shows orbs choreographing a value sweep. Seeded like the prompt-tooling starter presets
(idempotent, hideable).

## Testing & verification
- **Pure unit (vitest):** every easing fn (endpoints + monotonic where expected); `sampleTrack`
  (between keyframes, easing applied, clamp before/after, empty→null, single-keyframe); `sampleClip`
  map; `motionOffset` per style (orbit radius ∝ valueT, bob on Y, pulse scale, still=0, selected
  node excluded); binding validation (`isBindable` accepts numeric params, rejects others/unknown);
  `planMotionRender` (frame count, even spacing, patch values match sampling); persistence migration
  (missing `motion` → seeded; present → loaded). All existing 225 tests stay green; tsc clean.
- **Browser preview smoke:** Timeline panel renders; Play animates orbs and sweeps the Sampler orb
  cool→hot in a loop; scrub seeks; pausing returns the scene to idle (no continuous rAF — verify no
  frame churn/warnings); add a track + keyframe; bake writes the value into the param; reduced-motion
  never auto-plays; no console errors; the render button still does a normal single render (Phase 1
  doesn't change rendering).

## Acceptance
1. A Motion Timeline exists; Play choreographs the orbs and drives their gradients/rings from
   sampled values; Stop/pause returns the editor to its idle loop.
2. You can bind a numeric param to a track, add/move keyframes, choose easing, scrub, and see orbs
   respond live; `bake` commits a sampled value to the workflow (undo-safe).
3. `planMotionRender` produces correct per-frame patches (tested); the bridge render path is a
   clearly-labeled Phase-2 stub, never a fake render.
4. Clips persist across reload; old saved state loads; editing/wiring/2D all still work; 225+ tests
   green; tsc clean. A demo clip makes the feature instantly playable.
