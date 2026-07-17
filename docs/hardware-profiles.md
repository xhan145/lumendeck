# Hardware profiles & the GTX 1650 4GB low-VRAM mode

LumenDeck can tune its generation defaults and memory optimizations to the GPU
it is running on. This is driven by a **hardware profile** — a bundle of
conservative-vs-permissive settings selected in **Performance → Hardware
Profile**.

The headline profile is **GTX 1650 4GB**, designed for NVIDIA GTX 1650-class
cards (and any NVIDIA GPU with roughly 4 GB of VRAM). It prioritizes stability,
predictable memory use, and usable performance over raw speed or image size.

## Profiles

| Profile (id) | For | Behavior |
| --- | --- | --- |
| **Automatic** (`auto`) | Everyone (default) | Resolves to a concrete profile from detected VRAM + capability. |
| **GTX 1650 4GB** (`gtx_1650_4gb`) | ~4 GB NVIDIA GPUs | Low-VRAM: CPU offload, 512² default / 768² cap, hires off, one model on GPU. |
| **Balanced** (`balanced`) | ~6–8 GB GPUs | Today's default behavior. Slicing on, no forced offload. |
| **High Performance** (`high_performance`) | 12 GB+ GPUs | Speed/size first, no memory savings. |
| **CPU Mode** (`cpu`) | No CUDA GPU | fp32 on the CPU — slow but stable. |

`Automatic` never matches on the device **name** — it uses total VRAM and CUDA
capability, so a non-"GTX 1650" 4 GB card (e.g. an RTX A2000 4GB) still gets the
low-VRAM profile. You can also select **GTX 1650 4GB** manually on any similar
4 GB card.

**Users who do nothing keep their existing behavior.** With `auto`, a healthy
8 GB GPU resolves to Balanced (today's defaults) and a big GPU to High
Performance; unknown hardware (bridge offline, no CUDA) also stays Balanced.
Only the constrained profiles (GTX 1650 4GB / CPU) change the job — and they
apply to **local Diffusers bridge renders only**. Mock, ComfyUI, and Cloud
renders are never clamped by a local GPU profile. Constrained resolution caps
preserve aspect ratio (1216×832 → 768×528, never 768×768). The same treatment
covers single renders, batches, Auto-Evolve, motion-clip frames, and TurboForge
benchmarks. On the 4GB profile, SVD video / Flux / SDXL-refiner workflows are
gated by a compatibility health warning instead; CPU Mode has no VRAM budget to
exceed (slow, not OOM-prone), so it clamps jobs but emits no compat warnings.

## GTX 1650 4GB defaults

The rows below are the profile's design targets. The enforced ones at render
time are the resolution cap, hires-off, precision, and the offload/slicing
directive; batch/queue concurrency is already serial in the app.

| Setting | Value |
| --- | --- |
| Batch size | 1 |
| Concurrent generations | 1 |
| Parallel model loading | disabled |
| Default resolution | 512×512 |
| Max resolution (cap) | 768×768 |
| Hires fix | disabled |
| Large upscale | warn (tiled) |
| Model cache size | 1 (active model only) |
| Preload checkpoints | disabled |
| VRAM budget | 4096 MB |

### Precision

Preference order **fp16 → mixed → fp32**. bf16 is **never** used on this profile
— GTX 1650 (Turing) has no reliable bf16 path, and the profile does not list it.
If fp16 is unavailable (e.g. CPU fallback), the worker loads in fp32.

### Memory optimizations (Diffusers backend)

Enabled through an explicit backend compatibility layer (only the Diffusers
bridge worker honors the directive; other backends ignore it):

- attention slicing, VAE slicing, VAE tiling
- **model CPU offload** — only the active submodule stays on the GPU
- memory-efficient attention, text-encoder/idle-component unloading
- references are cleared **before** the CUDA cache is released

The worker never calls `.to("cuda")` on a pipeline after offload is enabled.
When no low-VRAM directive is present the worker takes its unchanged legacy path.

## Memory-budget policy

A centralized, deterministic estimator (`src/core/hardware/memoryBudget.ts`)
returns a structured verdict rather than scattering GPU-name checks:

```ts
{ status: "safe" | "warning" | "blocked", estimatedVramMb: 3600,
  reasons: ["SDXL requires CPU offload on a 4GB GPU", ...],
  recommendedChanges: ["Reduce resolution to 512x512", "Disable the refiner", ...],
  isEstimate: true }
```

The number is a deterministic **estimate**, never a measurement. It considers
model family, resolution, batch, ControlNet/LoRA counts, VAE mode, upscaler,
refiner, previews, and offload.

## Model compatibility (GTX 1650 4GB)

| Category | Examples |
| --- | --- |
| Recommended | SD 1.5, ≤1 ControlNet, ≤2 LoRAs |
| Compatible with limitations | SD 1.5 + many extra networks |
| CPU offload required | SDXL / SD3 |
| High risk of out-of-memory | SDXL + refiner, SDXL + 2 ControlNets |
| Unsupported in this mode | Flux, video / animation |

Classification is by architecture and workflow shape, **not file size**.

## Out-of-memory handling & the single safe retry

If a real GPU render exhausts VRAM, the bridge worker:

1. stops the operation, keeps the process alive,
2. drops all model references and releases the CUDA cache,
3. returns a **categorized** OOM error (never swallowing unrelated exceptions).

The UI then performs **exactly one** safe retry with conservative settings
(512×512, hires off, aggressive sequential CPU offload).
The retry is a transient job override — it **never overwrites your saved
profile**. It runs at most once; there is no retry loop.

Message shown on the queue item:

> GPU ran out of memory — retried once with safe 4GB settings (512×512, CPU
> offload).

A render that succeeded via the safe retry finishes **done with warning** (the
shrunk size stays visible) and its manifest records the dimensions that
actually rendered plus a `safeRetryUsed` flag.

## Detection & diagnostics

Detection is best-effort and **never blocks launch** — no GPU, no CUDA, an
absent bridge status, or a CUDA init failure all degrade gracefully to
**Balanced** (unconstrained: existing behavior, no clamps). `Automatic` only
ever constrains a job on affirmative evidence of a ~4 GB CUDA card; **CPU
Mode** is an explicit choice, never an automatic one. No internet access,
driver install, or package install is triggered.

The **Diagnostics** page includes a redacted `[Hardware profile]` section
(selected/effective profile, GPU, VRAM, backend, CUDA, precision, active
optimizations, requested resolution/batch, model family, OOM category, fallback
status). It **never** logs prompts, negative prompts, images, image metadata,
keys, or private paths.

## Where it lives

- `src/core/hardware/` — pure, tested: profiles, detection, memory budget,
  compatibility, optimization selection, safe retry, job transform.
- `src/state/appSettings.ts` — `hardwareProfile` persistence (unknown → `auto`).
- `src/components/HardwareProfilePanel.tsx` — the Performance-page selector + status.
- `bridge/diffusers_backend.py` — worker VRAM detection, low-VRAM load path, OOM cleanup.

Tests: `tests/hardware*.test.ts`, `tests/healthBudget.test.ts`,
`bridge/test_hardware.py`.
