# LumenDeck — Better Real Models (Spec C, 2026-07-03)

Make the Model capsule actually steer real diffusion: multiple hub models, local
checkpoint files, and real LoRA application through the diffusers worker.

> Part of the user-approved v0.3 sequence ("do all", autonomous).

## Problem
The diffusers path always renders `stabilityai/sd-turbo` regardless of the selected
checkpoint, and LoRAs are manifest metadata only — never applied to real renders.

## Design
### Model resolution (bridge, `server.py`)
`_resolve_render_targets(job, shelf, model_root)` — pure/testable — annotates the job:
- `modelRef`:
  - shelf id `diffusers-real` (or unknown/demo id) → `{kind:"hub", id:<default model id>}`
  - shelf id `diffusers-sdxl` → `{kind:"hub", id:"stabilityai/sdxl-turbo"}`
  - a **scanned local checkpoint** whose file exists → `{kind:"file", path:<abs>, family}`
- `loraFiles`: enabled rack LoRAs resolved to scanned files that exist →
  `[{path, weight}]`; demo/missing LoRAs are skipped (logged), never fatal.

### Worker (`diffusers_backend._WORKER_SOURCE`)
- `load_pipe(model_ref)`: hub → `AutoPipelineForText2Image.from_pretrained(id)`;
  file → `StableDiffusionXLPipeline`/`StableDiffusionPipeline.from_single_file(path)`
  chosen by family/filename ("xl" ⇒ SDXL).
- Turbo rule: model id containing "turbo" ⇒ guidance 0, steps clamped 1–8; otherwise
  guidance = job `cfg`, steps clamped 1–50 (real CFG models need it).
- LoRAs: `pipe.load_lora_weights(path, adapter_name=...)` per file, then
  `pipe.set_adapters(names, weights)`; each failure logged and skipped.

### Shelf
`/models` gains a second hub entry `diffusers-sdxl` ("sdxl-turbo (real diffusion)",
family SDXL). `installed` = deps ready AND weights present in the HF cache
(filesystem check `models--stabilityai--sdxl-turbo`), so Graph Health blocks
render-before-download instead of surprise-downloading ~7 GB.

### Frontend
None required: `modelId` already flows in the job; the new shelf entry and LoRA
manifest records already render.

## Testing / verification
- Unit (pure): resolution for hub ids, unknown ids, scanned file checkpoints
  (tmp files), demo LoRAs skipped, scanned LoRAs resolved.
- Live: default sd-turbo render unchanged (progress + PNG).
- **Honest limits:** `from_single_file`, SDXL-turbo, and real-LoRA execution are
  implemented and unit-tested at the resolution layer, but not executed here —
  no local checkpoint/LoRA files exist on this machine and SDXL weights are a
  ~7 GB download. The default hub path is fully verified.

## Acceptance
1. Selecting sd-turbo vs sdxl-turbo vs a scanned checkpoint changes what the worker loads.
2. Enabled scanned LoRAs are applied with their weights; demo LoRAs skipped safely.
3. sdxl entry appears on the shelf, blocked until cached. 4. All tests green.
