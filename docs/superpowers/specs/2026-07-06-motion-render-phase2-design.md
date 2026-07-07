# LumenDeck — Motion Render (Living Constellation Phase 2, 2026-07-06)

Turn a keyframed motion clip into an **actual rendered animation**: sweep each track's bound
parameter across the timeline, render one real frame per sample through the resident diffusion
model, and assemble a video into the Gallery. This wires the `renderMotionClip` seam that Phase 1
left as a loud `NotImplemented` throw. Autonomous continuation of the Motion Engine (v0.14.0).

## What it animates (honest scope)
A motion track binds a node param to keyframes (e.g. Sampler `cfg` 4→18→7, or img2img
`denoiseStrength`, ControlNet strength, hires denoise, seed). Phase 2 renders each frame with that
frame's sampled param values, so the OUTPUT IMAGE morphs across the clip. Purely-visual orb-motion
(position/scale in the 3D view) does not change the rendered pixels and is intentionally excluded
from the render — the render animates *generation values*, not camera. This is stated in the UI so
users aren't surprised.

## Architecture — render the whole sequence in the persistent worker
The worker already keeps the model resident between renders, so rendering N frames in ONE request
pays the model-load cost once (vs N HTTP round-trips each reloading). Frontend sends the full plan;
the worker loops, reusing the loaded pipe.

### Frontend (`src/core/motion/renderPlan.ts` + adapter + UI)
- Replace the throwing `renderMotionClip` with `buildMotionRenderJobs(workflow, clip, {frames})`:
  for each `MotionRenderFrame` from `planMotionRender`, apply its `paramPatches` to a cloned
  workflow (pure `applyPatches`) and call the existing `buildRenderJob` → a per-frame `RenderJob`.
  Returns `{ jobs: RenderJob[], frameTimes: number[] }`. Pure and unit-tested (no bridge).
- `HttpAdapter.renderMotion(clip jobs, {fps, format}, onProgress)` POSTs `/render-motion` and
  returns a `RenderResult` (mediaType `'video'`) — identical shape to AnimateDiff so the Gallery,
  manifest, and download paths already work. MockAdapter renders a short procedural sequence so the
  in-browser demo still produces something (clearly a placeholder).
- **Motion Timeline** gains a **Render clip** control: frame-count (clamped 4–60) + fps (6–30) +
  format (mp4/gif), a **Render** button, and an inline progress bar fed by the per-frame progress.
  Result lands in the Gallery. Disabled with a tooltip on the Mock backend note.

### Bridge (`server.py` + `diffusers_backend.py`, stdlib server)
- `POST /render-motion` body `{ jobs: [RenderJob...], fps, format, jobId? }` →
  `diffusers_backend.render_motion(payload)`; reuses `_resolve_render_targets` per job and the
  existing `_JOB_ID`/progress-file plumbing; loud error (never a silent placeholder). If diffusers
  isn't available it renders each frame procedurally via `renderer.py` and returns the video with
  `fallback:true` + reason.
- `diffusers_backend.render_motion(payload)` → persistent-worker op **`render_sequence`**: the
  worker loops the jobs, running the SAME single-image `do_generate` path per frame (model stays
  resident; ControlNet/img2img/hires all honored per-frame), collects PIL frames, writes progress
  `{phase:'frame', step:i, steps:N}` after each, then **encodes**: MP4 via `cv2.VideoWriter`
  (`mp4v`; opencv is already installed) → base64; **GIF fallback** via Pillow `save_all` (the
  proven AnimateDiff path) if cv2/mp4 fails or `format=='gif'`. Returns
  `{video_base64, mediaType:'video', mimeType, extension, seed, frameCount, fps}`.
- Frame count clamped 1–120 server-side; VRAM safety: frames render one at a time (no batch), so
  peak VRAM equals a single render.

## Data flow & manifest
- Manifest for a motion render records `{ motion: { clipId, clipName, frames, fps, durationSec } }`
  plus the base workflow, so the animation is reproducible.
- The Gallery item is a normal video item (`<video>` playback + download) with a small "Motion"
  badge.

## Testing & verification
- **Pure unit (vitest):** `applyPatches` (clones, sets nested sampler/imageLoader params, leaves
  others untouched); `buildMotionRenderJobs` (N jobs, correct per-frame cfg from a known clip,
  frames=1 edge, empty-clip guard); adapter result mapping (video_base64 → dataUrl, fallback
  passthrough); manifest motion fields. All existing 320 tests stay green; tsc clean.
- **Bridge (pure):** `/render-motion` route shape through `build_response`; render_motion payload
  validation + frame clamp; the encode helper picks mp4 then gif (mock the encoders).
- **GPU (this machine, sd-turbo):** render a real 3s demo clip at 8 frames → a valid non-empty
  mp4 (or gif) whose frames differ (cfg sweep visibly changes the image); confirm the model loads
  once (sequence faster than N× cold renders); progress advances frame-by-frame.
- **Browser smoke:** Render clip button → progress → video appears in the Gallery and plays.

## Acceptance
1. In the Motion Timeline, "Render clip" turns the demo clip (cfg 4→18→7) into a real rendered
   video whose frames visibly change across the sweep; it appears in the Gallery and plays.
2. The sequence renders with the model loaded once (persistent worker), one frame's VRAM peak.
3. Missing/unavailable diffusion → procedural frames with a loud fallback reason, never silent.
4. No workflow schema change; old saves load; 320+ tests green; tsc clean; MSI builds + verifies.
