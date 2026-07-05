# LumenDeck v0.6 Roadmap — Real Video + Advanced Generation (2026-07-04)

Five features, approved via brainstorming. Each is its own spec → plan → build cycle.
They share one theme: extend the render pipeline beyond plain text→image.

## Why now
"Videos don't render" root cause: `output:"video"` is **always procedural** (server forces
`_procedural`), so enabling video on a real model yields an abstract GIF, never an animation
of the user's model. On the Mock backend it degrades to an SVG placeholder. The fix is real
text→video via **AnimateDiff**, which is build #1.

## Shared plumbing (touched by several features)
- **Bridge worker** (`bridge/diffusers_backend.py` `do_generate`): today loads a text2img
  pipeline. Img2img, AnimateDiff, ControlNet, and hi-res fix each need a different pipeline
  class from the same checkpoint. Introduce a small **pipeline factory** keyed by task
  (`text2img | img2img | animate | controlnet`) with per-task caching, so the persistent
  worker reuses loaded weights across tasks where possible.
- **RenderJob** (`src/bridge/adapter.ts`): already carries video params; add `initImage`,
  `maskImage`, `denoise`, `controlnet`, `hires` fields as each feature lands.
- **Capsules** (`src/core/capsules.ts`): each feature is a capsule with typed sockets, so it
  shows in both Recipe and Graph and flows through `buildRenderJob`. Follow the existing
  Video capsule pattern.

## Build order (dependency-aware)
1. **AnimateDiff (real video)** — fixes the reported bug. Mostly self-contained: motion
   adapter on the selected checkpoint. Full spec below.
2. **Img2img + inpainting** — foundational image-conditioning plumbing (`initImage`/`maskImage`
   + `denoise`); ControlNet and hi-res build on it.
3. **ControlNet (pose/depth/canny)** — structural guidance; reuses img-input plumbing.
4. **Upscaling / hi-res fix** — second img2img pass at higher resolution; reuses #2.
5. **Batch / seed grids** — frontend/queue-centric; independent, can slot anytime.

---

## Build #1 spec — AnimateDiff real video

### Goal
Enabling the Video capsule animates the **selected real model** (not a procedural swirl),
via diffusers AnimateDiff, exported as an animated GIF. Procedural GIF stays as the
guaranteed fallback.

### Model support
- **SD1.5 checkpoints** (e.g. the user's `v1-5-pruned`): `MotionAdapter.from_pretrained(
  "guoyww/animatediff-motion-adapter-v1-5-2")` + `AnimateDiffPipeline` from the single-file
  checkpoint. Primary, well-supported path.
- **SDXL checkpoints** (Pony/etc.): `guoyww/animatediff-motion-adapter-sdxl-beta` +
  `AnimateDiffSDXLPipeline`. Marked **beta**; on failure, fall back to procedural GIF with a
  loud reason (reuse the existing fallback banner). Detect family via the existing
  `detect_single_file_family`.

### Bridge (`diffusers_backend.py`)
- `do_generate(job, state)`: when `job.output == "video"`, branch to `_animate(job, state)`:
  - Resolve motion adapter id by family (v1-5-2 for SD1.5, sdxl-beta for SDXL).
  - Build/caches an `AnimateDiff(SDXL)Pipeline` in `state` keyed by `(checkpoint, adapter)`.
  - `num_frames = clamp(job.frameCount, 8, 32)`, `guidance = job.cfg` (SD1.5) / 0 for turbo,
    `num_inference_steps` per the turbo rule already in place.
  - Progress via the existing `callback_on_step_end` → progress file.
  - Encode frames → GIF with **Pillow** (`frames[0].save(buf, format="GIF", save_all=True,
    append_images=frames[1:], duration=1000/fps, loop=0 if job.loop else 1, disposal=2)`).
  - Return `{video_base64, seed, mediaType:"video", mimeType:"image/gif", extension:"gif"}`.
- LoRAs already supported by the pipeline factory apply to AnimateDiff too.

### Server (`server.py`)
- `/generate` video branch: if `renderer in (diffusers,auto)` and `_diffusers_available()` →
  `diffusers_backend.generate(job)` (which now handles video). On exception in `auto` →
  procedural GIF + `fallback`/`fallbackReason` (existing loud-fallback path). `procedural`
  renderer or diffusers-unavailable → procedural GIF (current behavior).

### Runtime install
- `install_runtime()` / a new `download_motion_adapter()` fetches the SD1.5 motion adapter
  (~1.7 GB) into the HF cache; SDXL-beta fetched lazily on first SDXL video. Surface status
  in the Backend/Guide model panels (adapter present?).

### Frontend
- Minimal: the Video capsule already provides frameCount/fps/loop. `motionStrength` maps to
  AnimateDiff `guidance_scale` nudge; `cameraMotion` is procedural-only (hide/disable it for
  the AnimateDiff path, or relabel as "procedural motion"). Gallery already shows GIF via
  `<img>`. Add a small "real vs procedural" tag from `manifest.media.engine`.
- Fix Mock video: return a real animated GIF (encode a few canvas frames) instead of an SVG,
  so video never silently degrades on Mock.

### Testing
- Bridge unit: family→adapter-id mapping; `_animate` guarded when torch/diffusers absent
  (RuntimeError). GIF encoder produces valid multi-frame `GIF89a` (Pillow).
- Live (GPU): SD1.5 checkpoint video render returns a real animated GIF; SDXL attempts and
  falls back cleanly if the beta adapter fails.
- **Honest limit:** AnimateDiff weights (~1.7 GB) download on first use; full GPU inference is
  verified on the dev machine but not in CI.

### Acceptance
1. Video capsule on an SD1.5 model produces a real animated GIF of that model's content.
2. SDXL video attempts AnimateDiff-SDXL and, on failure, returns a procedural GIF with a
   visible reason (never a silent placeholder).
3. Mock video returns a real animated GIF, not an SVG.
4. Existing image renders + all tests remain green.
