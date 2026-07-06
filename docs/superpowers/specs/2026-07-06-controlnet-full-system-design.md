# LumenDeck — Full ControlNet System (2026-07-06, Sub-project A)

Upgrade ControlNet from single-type canny to the **full common set** — canny, depth, pose,
scribble, lineart, softedge, tile — with **MultiControlNet stacking**, **on-demand preprocess
preview**, and a **capability map** with graceful fallback per model family. Approved via
brainstorming (user chose: full set / best-available per family / preview on demand / stacking).

## Data model & capsule — ControlNet Rack

A new **`controlNetRack`** capsule mirrors the LoRA Rack: `params.slots` is a list of
`ControlSlot = { id, type, strength, image, enabled }` where
`type ∈ canny|depth|pose|scribble|lineart|softedge|tile`. Each slot carries its **own** control
image (base64 data URL, uploaded like the Load Image capsule) because stacked controls need
different sources. The existing single `controlNetApply` capsule stays graph-valid and is still
collected (legacy path).

`buildRenderJob` collects enabled slots that have an image →
`job.controlNets: [{ model: <type>, strength, image }]` (the `model` key carries the type string,
matching the existing `job.controlNet` convention). The legacy singular `job.controlNet`
(controlNetApply + Load Image) is appended to the same array. For old-sidecar back-compat the
first entry is also mirrored into `job.controlNet`.

## Bridge — capability map, preprocessors, MultiControlNet

**Capability map** `CONTROLNET_MODELS = { family: { type: hf_model_id } }` defined once at module
level in `bridge/diffusers_backend.py` and passed to the worker **inside the job**
(`job.controlnetMap`) so the worker never needs a duplicated table:

- **SD1.5** (cross_attention_dim 768) — full set: `lllyasviel/control_v11p_sd15_canny`,
  `control_v11f1p_sd15_depth`, `control_v11p_sd15_openpose`, `control_v11p_sd15_scribble`,
  `control_v11p_sd15_lineart`, `control_v11p_sd15_softedge`, `control_v11f1e_sd15_tile`.
- **SD2.1** (1024) — `thibaud/controlnet-sd21-canny-diffusers`, `-sd21-depth-diffusers`,
  `-sd21-openpose-diffusers` (canny/depth/pose only).
- **SDXL** (2048) — official `diffusers/controlnet-canny-sdxl-1.0`, `-depth-sdxl-1.0`,
  `thibaud/controlnet-openpose-sdxl-1.0`; community `xinsir/controlnet-scribble-sdxl-1.0`,
  `xinsir/controlnet-tile-sdxl-1.0` (scribble/tile; lineart/softedge unsupported on SDXL).

Family is detected **in the worker at render time** from `pipe.unet.config.cross_attention_dim`
(768/1024/2048 — already how canny picks). For the capabilities route (no loaded pipe) a
module-level `estimate_family(model_ref)` gives a best-effort answer: single-file checkpoints via
the safetensors header (struct+json, no torch), hub ids via heuristics (`xl`→SDXL,
`sd-turbo|sd2|v2`→SD2.1, else SD1.5).

**Preprocessors** via `controlnet_aux` (run in the persistent worker, which has torch):
Canny (no download), `MidasDetector` (depth), `OpenposeDetector` (pose), `HEDdetector`
scribble-mode (scribble), `LineartDetector` (lineart), `PidiNetDetector` (softedge), and **tile =
passthrough** (no preprocessing). Detector instances cached in worker state; first use downloads
from `lllyasviel/Annotators`. A new worker op `preprocess` (`{type, image, width, height}` →
map base64) sits alongside `generate` in the serve loop.

**Render path** in worker `do_generate`: normalize `job.controlNets` (list) or legacy
`job.controlNet` (single) → list. For each control: preprocess its image, load its
`ControlNetModel` (cached per `family:type` in worker state). One control → single model;
multiple → a **list** (diffusers forms MultiControlNet), `image=[maps]`,
`controlnet_conditioning_scale=[strengths]`. `enable_model_cpu_offload()` for 8 GB VRAM. A type
unsupported for the loaded family is **dropped, not fatal** — dropped entries are returned in the
result as `droppedControls: [{type, reason}]`; if *all* drop, render proceeds plain with the same
loud `droppedControls`. Existing canny/img2img/hires/video branches unchanged; ControlNet applies
to the text2img path (ControlNet+img2img combined is out of scope — future note).

**Server routes** (`build_response`, pure/stdlib):
- `GET /controlnet/capabilities?model=<shelf id>` → `{"family": "...", "types": [...]}` using
  `estimate_family` + the map.
- `POST /controlnet/preprocess` body `{type, image, width?, height?}` →
  `{"map_base64": "<raw b64 PNG>"}` or a clear JSON error.
- `install_runtime()` adds `controlnet_aux` + `opencv-python-headless` to the managed-runtime pip
  install so end-user installs get preprocessors.

## Frontend — rack UI, preview, health, manifest

- **Rack UI** mirrors the LoRA Rack component pattern: add/remove/toggle slots, type select
  (7 options), strength slider (0–2), per-slot image upload (FileReader → data URL, thumbnail +
  clear), and a **Preview** button per slot that POSTs `/controlnet/preprocess` and shows the
  returned map (depth map / pose skeleton / edges) inline. Preview disabled with a tooltip when
  the bridge is offline (Mock adapter).
- **Capability mirror** `src/core/controlnet.ts`: the same family→types table plus
  `estimateFamilyFromModelId` heuristic — pure TS so the **health checker** stays fetch-free.
  Health warnings: (1) a rack slot's type unsupported by the selected model's family; (2) more
  than 2 enabled controls (VRAM caution on 8 GB).
- **Result surfacing**: `droppedControls` in a render result surfaces as a queue warning banner
  (same mechanism as `fallbackReason`).
- **Manifest** records `controlNets: [{type, strength}]` per render.

## Testing & verification

- **TS**: `buildRenderJob` slot collection → `controlNets[]` (+ legacy merge); capability/health
  rules; adapter `droppedControls` mapping. All existing tests stay green.
- **Bridge (pure, no GPU)**: capability lookup + `estimate_family`; route shape tests for
  `/controlnet/capabilities` and `/controlnet/preprocess` through `build_response`.
- **GPU (this machine)**: all 7 preprocessors return valid maps (preprocessors are
  family-independent); depth render, pose render, and a **stacked depth+pose** render each
  produce a guided image on the default model; capability route answers correctly for sd-turbo
  (SD2.1 → canny/depth/pose) and a local SDXL checkpoint.
- **Honest limits**: each ControlNet model is a multi-hundred-MB download on first use.
  Type×family render combos beyond the GPU-verified set (esp. xinsir SDXL community models and
  the SD1.5 full set if no SD1.5 checkpoint is on disk) are wired per the map and smoke-tested at
  most — called out in the release notes, never silently broken (drops are loud).

## Acceptance

1. Rack with a depth slot + portrait photo → depth-guided render; pose slot + person photo →
   pose-guided render; both slots enabled → stacked render honoring both.
2. Preview shows the extracted map for every type without spending a render.
3. Selecting a type the current model can't do → health warning up front, loud
   `droppedControls` if rendered anyway — never a silent wrong result.
4. All existing backends, tests, and the canny/img2img/hires/batch/video paths remain green.
