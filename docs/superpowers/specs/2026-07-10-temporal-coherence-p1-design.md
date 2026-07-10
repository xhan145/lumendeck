# Temporal Coherence — Phase 1 design

**Date:** 2026-07-10
**Version target:** v0.27.0 (minor)
**Sub-project 3 of 3** (Unpublish → Creative-intelligence → **Temporal-coherence**)
**Phase 1:** SVD "Animate this render" (image-to-video)

## Problem & context

LumenDeck already has real temporal coherence for **text→video**: `_animate` in
`bridge/diffusers_backend.py` runs **AnimateDiff** on the user's selected checkpoint
(motion adapters for SD1.5/SDXL, CPU-offload for ~8GB cards), reachable via the `video`
capsule ("Render video"). What is missing is **image→video**: taking an existing still
render and animating it into a short, coherent clip — the "bring my render to life"
capability the Video Export Suite explicitly deferred ("Real temporal coherence (SVD)").

This phase adds **Stable Video Diffusion (SVD) image-to-video** as an "Animate this
render" action. It is the heavy-ML flagship, so Phase 1 is deliberately one tight,
honest path: one still → one coherent H.264 clip, with real guardrails and no silent
fallback. (The separate per-frame Motion-Engine keyframe path and the AnimateDiff
text→video path are untouched.)

## Core decisions (locked in brainstorming)

- **Capability = SVD image-to-video** (chosen over hardening AnimateDiff / smoothing the
  keyframe path). It is the genuinely-new, highest-impact capability.
- **Model acquisition = local folder.** The user places an SVD model (a diffusers folder
  whose `model_index.json` `_class_name === "StableVideoDiffusionPipeline"`, OR an
  `svd*.safetensors` single file) in their models directory; the existing scanner detects
  it. Getting/licensing SVD is the user's responsibility, exactly like any checkpoint. No
  in-app credential handling, no gated auto-download (deferred). If none is present, the
  Animate action shows an honest "no SVD model" pointer.
- **Perf posture = conservative + honest.** Default 14 frames, small `decode_chunk_size`,
  CPU-offload; an upfront "this can take a few minutes on 8GB" note + live progress.
  Prioritize "finishes without OOM" over speed. Advanced settings may push higher.

## Architecture

Four units: bridge worker → bridge op → TS adapter → store+UI, plus scanner detection.

### 1. Bridge — `_animate_svd(job, state, report)` (new, `bridge/diffusers_backend.py`)

- Loads `StableVideoDiffusionPipeline` from the local model path: `from_pretrained(dir)`
  for a diffusers folder, or `from_single_file(file)` for an `svd*.safetensors`. fp16 on
  CUDA. Applies `enable_model_cpu_offload()` + `enable_vae_slicing()`/tiling so it fits
  ~8GB (slow but finishes — same discipline as `load_animate_pipe`). Cache the pipe on
  `state` keyed by the model path (like `anim_pipe`), freeing the still/anim pipes first.
- **Input:** the still as base64 → PIL RGB → resized to an official SVD canvas by
  orientation: **landscape (w ≥ h) → 1024×576**, **portrait (w < h) → 576×1024** (SVD is
  trained only at these two; square/other inputs snap to the nearer one, default
  landscape). Center-crop to the target aspect before the resize so the frame isn't
  distorted.
- **Params (clamped):** `num_frames` (default 14, 8–25), `fps` (default 7, 1–30),
  `motion_bucket_id` (default 127, 1–255 — the UI "motion amount"), `noise_aug_strength`
  (default 0.02), `decode_chunk_size` (default 2, 1–8), `seed`.
- **Output:** `result.frames[0]` → **`_encode_sequence(frames, fps, 'mp4')`** → H.264
  (this finally exercises the real encoder for coherent video). Returns
  `{ video_base64, mediaType:'video', mimeType:'video/mp4', extension:'mp4', engine:'svd', seed }`.
- **Guardrails / honesty:**
  - CUDA OOM (`torch.cuda.OutOfMemoryError` / RuntimeError "out of memory") → a clear
    error: "Not enough VRAM for SVD at these settings — try fewer frames or a smaller
    decode chunk." Never a silent mock.
  - SVD model missing / diffusers unavailable → loud error naming the cause.
  - Progress: `report({phase:'loading'|'rendering'(step/steps)|'decoding'|'done'})` via
    the pipeline step callback.

### 2. Bridge op routing

- New command `animate_svd` (peer to `render_sequence`), dispatched in the persistent
  worker loop and the one-shot path. Payload `{ image, modelPath, ...params }`.
- A pure helper `svd_target_size(width, height) -> (w, h)` (the resize rule) and
  `clamp_svd_params(job) -> dict` are extracted so they are unit-testable without torch.

### 3. Scanner — detect SVD models (`bridge` scanner + shelf projection)

- The existing model scanner gains SVD recognition: a folder with
  `model_index.json`.`_class_name === "StableVideoDiffusionPipeline"`, or a file matching
  `svd*.safetensors` / `*svd*img2vid*.safetensors`, is surfaced with
  `capability: 'image-to-video'` (or `kind:'svd'`). The shelf/model list exposes these so
  the app knows whether any SVD model is available.
- A pure `isSvdModel(entry)` predicate is unit-tested.

### 4. TS adapter + store + UI

- **`src/bridge/adapter.ts`:** `AnimateStillOptions { frames; fps; motion; seed; modelPath? }`
  and `animateStill(imageBase64: string, opts: AnimateStillOptions, onProgress?): Promise<RenderResult>`
  on the adapter interface (`RenderResult.mediaType` already supports `'video'`).
  - `httpAdapter.animateStill` POSTs `{ image, ...opts }` to the bridge `animate_svd` op,
    streams progress, returns the mp4 `RenderResult`; throws loudly on a non-OK/error.
  - `mockAdapter.animateStill` returns an **honest** labeled mock clip (an SVG marked
    "mock — SVD needs a real backend"), never pretending to be SVD.
  - `comfyAdapter.animateStill` → unsupported error.
- **`src/state/store.ts`:** `svdModels: SvdModelInfo[]` (from the scan) + `animateStill(galleryId, opts): Promise<{ ok; error? }>`
  thunk: resolves the still's dataUrl → base64, calls `adapter.animateStill`, and on
  success adds the clip as a new gallery **video** item (manifest records
  `derivedFrom: galleryId`, engine 'svd', the params). Guards: an SVD model must be
  available AND a real backend selected (mock → honest placeholder result + note).
- **UI — `src/components/gallery/Gallery.tsx` drawer:** an **"Animate"** action beside
  Share/Publish. It opens a small inline panel: motion-amount slider, frames, fps, seed,
  and an upfront perf note. Disabled with a clear reason when no SVD model is present or
  no real backend is selected. Running → live progress; done → the clip appears in the
  gallery; error → the honest message inline.

## Data flow

Gallery still (dataUrl) → `animateStill(galleryId, opts)` → base64 → adapter
`animate_svd` → bridge `_animate_svd` (SVD pipeline → frames → H.264 mp4) → `RenderResult`
→ new gallery video item (derivedFrom the still). Progress streams to the drawer.

## Error handling / honesty (LumenDeck ethos)

- No SVD model → Animate disabled with "Put an SVD model in `<models dir>`".
- Mock/no real backend → Animate produces an explicitly-labeled mock clip, never a
  silent fake SVD.
- VRAM OOM / diffusers missing / decode failure → loud, specific error in the drawer; no
  silent fallback and no half-written gallery item.
- Frame/param values clamped server-side; a zero-frame or bad image errors clearly.

## Testing

- **Python (`bridge/test_svd.py`):** `clamp_svd_params` (defaults + bounds), `svd_target_size`
  (landscape→1024×576, portrait→576×1024, square→landscape default), `is_svd_model` detection
  (model_index class / filename / negatives), and that the mp4 encode path reuses
  `_encode_sequence` (already covered). The SVD model itself is NOT run in CI — the worker
  glue is covered by a worker-source parity test like the motion tests.
- **TS:** `animateStill` POSTs the right body + parses the mp4 result + throws on error
  (fetch-mock, like `publish.test.ts`); store `animateStill` lands a video item + guards
  (no model / mock backend); `mockAdapter.animateStill` returns an honest labeled clip.
- **Manual e2e (gated on a local SVD model):** with a real backend + SVD model present,
  Animate a still → a coherent mp4 lands in the gallery; OOM path shows the honest error.
- **Browser smoke:** the Animate drawer panel renders, disabled-state messaging correct,
  mock backend yields the labeled placeholder.

## Non-goals (Phase 1, deferred)

- SVD-XT 25-frame / high-res, camera-motion & FPS-conditioning controls, text-guided or
  ControlNet-guided SVD, batch animation, frame interpolation / upscaling.
- In-app gated auto-download / HF-token flow.
- AnimateDiff mp4-output hardening & first-class UI (separate follow-up).
- Motion-Engine keyframe-path temporal smoothing (separate follow-up).

## Rollout

- Bump `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` to `0.27.0`
  (`versionSync.test.ts` guards parity).
- Sidecar rebuild note: `_animate_svd` uses `StableVideoDiffusionPipeline` from the
  already-bundled `diffusers`; no new frozen-sidecar imports expected, but confirm the
  PyInstaller build still passes the 20MB guard (the managed cp314 runtime supplies torch/
  diffusers at runtime, so the frozen sidecar is unaffected).
- No public MSI release until explicitly authorized ("release").
