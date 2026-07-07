# LumenDeck

LumenDeck is a local-first, node-native generative image studio shell: a spiritual successor to
Disco Diffusion. It includes Guide, Recipe, Graph, Model Shelf, Gallery, Controls, Settings,
Diagnostics, Performance, LoRA Rack, and TurboForge performance planning.

**Two synchronized editors, one workflow object.** The **Recipe View** (beginner-friendly cards) and
the **Graph View** (a real, editable SVG node graph: searchable node palette, typed ports, duplicate,
delete, auto-layout, fit/reset view, keyboard move/delete) operate on the same underlying workflow, so
an edit in either shows up in the other immediately. Every capsule is edited through a shared,
accessible **Inspector**.

**Core Capsules:** Prompt, Model, LoRA Rack, Control, Sampler, Video, Canvas, Queue, Export, Manifest.

**Recipe portability (v0.2):** save the current workflow as a `.lumen` file and re-open it later, or
start from a built-in **template** (Neon Poster, Ink Sketch, Portrait Studio) from the Recipe View
header.

**Real generation (v0.2):** the desktop build **auto-starts a bundled render bridge**. The Backend
panel offers three bridge renderer modes: **procedural** (instant, offline, always works),
**diffusers** (real SD-Turbo), and **auto** (real if available, else procedural). It also includes a
real-photo model panel that checks Diffusers readiness, creates a managed local runtime when needed,
and downloads/loads SD-Turbo for the user. The existing **ComfyUI** adapter remains available for an
external ComfyUI server.

**Graph Health** runs before every render and flags missing/uninstalled models, broken links,
incompatible sockets, bad dimensions (non-multiple-of-8, too small/large), LoRA family conflicts, and
likely VRAM over-budget. Render is blocked with a reason while any error is present.

## Page map and first run

- **Guide**: first-run paths for Quick demo, built-in Diffusers, ComfyUI, and scanning your own models.
- **Recipe**: card-based workflow editing, `.lumen` save/load, and starter templates.
- **Graph**: editable node graph with health checks and a shared Inspector.
- **Model Shelf**: bundled demo catalog, Civitai search/download, and bring-your-own model folder scan.
- **Gallery**: local render history, export, restore graph, and fallback warnings.
- **Controls**: render button, batch/seed grid, queue, Inspector, LoRA Rack, and Health panel.
- **Settings**: backend URLs, bridge renderer mode, fallback toggle, runtime/model actions, storage/privacy, and reset controls.
- **Diagnostics**: copyable troubleshooting report for CUDA, Python/Torch, bridge, ComfyUI, folder scan, queue, and fallback state.
- **Performance**: TurboForge plan, presets, cache/compile flags, benchmark history, and measured-only speedup display.

Recommended first action: open **Diagnostics**, check the Diffusers bridge/model state, then use
**Install runtime + model** if CUDA/Torch/SD-Turbo are missing. Use **Quick demo** only to validate UI
flow; it is not a real model render.

The design spec and implementation plan live in [`docs/superpowers/`](docs/superpowers/). Brand:
Midnight `#071426`, Ion Cyan `#34D6F4`, Voltage Violet `#7C3AED`, Mango Fuse `#FF8A3D`, Signal Mint
`#45E6A6`, Paper `#FBFCFE`, Ink `#101828`, Slate `#475467`: dark-only, WCAG-AA contrast, visible
focus, reduced-motion aware.

## Run Locally

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5178/`.

Validation commands:

```bash
npm test
npm run build
```

## Quickest start — real images (Windows)

Double-click **`run.bat`**. It builds the app once, then starts the bridge which serves
the UI *and* the render API on one origin at **http://127.0.0.1:8787** (opens automatically).
Because everything is same-origin, the browser never hits a cross-origin/"failed to fetch"
error. If Python has the diffusion deps, renders are real:

```bash
python -m pip install torch numpy==1.26.4 diffusers==0.30.3 transformers==4.44.2 tokenizers==0.19.1 accelerate safetensors kornia
```

Without them the app still runs on the built-in procedural renderer, and the Backend panel
shows a one-click way to enable real diffusion.

**Developing?** `npm run dev` autostarts the bridge too (via a Vite plugin) and proxies the
API same-origin, so real rendering works in dev without extra terminals.

## Desktop app (Windows MSI)

LumenDeck ships as a native Windows desktop app via [Tauri](https://tauri.app): a small WebView2
shell around the built web app. As of v0.2 the app **bundles the render bridge as a sidecar and
auto-starts it on launch**, so generation plumbing works from a single installer with no manual
Python server step. The offline Procedural renderer works out of the box; real diffusion (SD-Turbo)
can be prepared from the app with Backend -> Diffusers bridge -> Install runtime + model. That
creates an app-local runtime under `%LOCALAPPDATA%\LumenDeck\diffusers-runtime`, installs CPU PyTorch
and Diffusers, then downloads/loads the Hugging Face weights.

**Install:** run the installer at
`src-tauri/target/release/bundle/msi/LumenDeck_0.2.0_x64_en-US.msi`. It requires the Microsoft
**WebView2** runtime, preinstalled on Windows 11.

**Build it yourself** (needs Rust + the MSVC toolchain and Python + PyInstaller; the WiX bundler is
fetched automatically):

```bash
npm install
pip install pyinstaller
python bridge/build_sidecar.py   # freezes the bridge -> src-tauri/binaries/
npm run tauri build              # runs `npm run build`, compiles the shell, bundles sidecar + .msi
```

The produced `.exe` is at `src-tauri/target/release/lumendeck.exe`. App icons are generated from
`src-tauri/icon-source.png` via `npm run tauri icon <path>`. The bundled bridge is spawned on port
8787 and terminates with the app (stdin-EOF watchdog + Tauri child cleanup).

## Backends

## Fallback render honesty

LumenDeck marks non-real output explicitly. If the selected backend fails and LumenDeck uses Mock, or
if the bridge returns a procedural placeholder while Diffusers was expected, the queue shows
`done + warning`, the Gallery card gets a **Fallback** badge, and the detail drawer records the
fallback reason. Exported manifests include selected backend, actual backend, render mode, fallback
flag, fallback reason, and TurboForge warnings.

Mock and procedural output are useful for smoke tests, previews, and app development. They should not
be treated as clean real model renders.

## Storage limitations

In dev/web mode the Gallery uses browser/localStorage persistence with base64 media. This is limited
and can be cleared by browser profile cleanup. Export important renders and manifests from Gallery.
The desktop filesystem gallery storage path is scaffolded as `%LOCALAPPDATA%\LumenDeck\gallery` with
planned `renders`, `manifests`, and `thumbnails` subfolders.

Generated media, model weights, caches, Python runtimes, build output, and Tauri targets are ignored
by git. Do not commit `.safetensors`, `.ckpt`, `.pt`, `.pth`, `.onnx`, generated videos, or runtime
caches.

### Video Renders

Enable the **Video** capsule in Recipe or Graph view to render a short animated loop. The built-in
bridge returns deterministic animated GIF output (`mediaType: video`, `mimeType: image/gif`) with
frame count, FPS, motion strength, camera motion, and loop settings recorded in the manifest.

### Mock Backend

The Mock backend is built in and needs no GPU. It creates deterministic procedural images and SVG
animation previews so you can
test prompts, manifests, gallery restore, TurboForge planning, benchmark storage, and UI flow.

Use it when:

- You are developing the app UI.
- ComfyUI is not running.
- You want no-GPU smoke tests.

Mock timings are app-validation timings only. They are not model speed benchmarks.

### ComfyUI API Backend

LumenDeck can connect directly to a local ComfyUI server.

1. Start ComfyUI normally.
2. In LumenDeck, open the Backend panel.
3. Select `ComfyUI API`.
4. Set the URL, usually `http://127.0.0.1:8188`.
5. Click `Test connection`.
6. Select a checkpoint in Model Shelf or edit the ComfyUI template checkpoint name.
7. Render.

The ComfyUI path checks `/system_stats`, submits a workflow to `/prompt`, polls
`/history/{prompt_id}`, and fetches the output via `/view`.

If ComfyUI is offline, blocked by CORS, or rejects the sample workflow, LumenDeck shows a
plain-English error. If `Fallback to mock` is enabled, the app renders with Mock instead and records
the fallback in the manifest warning data.

Workflow import/export placeholders are visible in Diagnostics for future ComfyUI workflow JSON
support. They are disabled until the mapping engine is implemented.

### Diffusers Bridge

A tiny local HTTP backend that gives LumenDeck a real generation path plus a local model scanner,
with **no GPU or heavy dependencies** required for the default path. The desktop app bundles the
pure-stdlib server as a sidecar and starts it automatically. Its default generator is a
pure-standard-library procedural renderer that produces deterministic, reproducible PNGs and animated
GIFs from a seed:
the reference implementation of the `BackendAdapter` contract.

```bash
cd bridge
python server.py --port 8787
```

In LumenDeck's Backend panel choose **Diffusers bridge**, set the URL to `http://127.0.0.1:8787`, and
**Test connection**. Open **Model Shelf -> Bring your own models**, paste a folder path, and scan it
to replace the demo catalog with local checkpoints/LoRAs (file hashing + family inference). The older
`LUMENDECK_MODEL_DIR` environment variable still works for scripted launches.

For real SD-Turbo photos, use **Install runtime + model** in the Backend panel. LumenDeck creates an
app-local runtime, installs PyTorch + Diffusers, and downloads/loads `stabilityai/sd-turbo` into the
Hugging Face cache. On NVIDIA systems it installs CUDA PyTorch; otherwise it falls back to CPU
PyTorch. A compatible Python 3.10-3.13 install must be available; Python 3.12 is the recommended
target.

Advanced/manual install:

```bash
python -m pip install torch numpy==1.26.4 diffusers==0.30.3 transformers==4.44.2 tokenizers==0.19.1 accelerate safetensors kornia
```

Then use **Check model** and **Download model** in the Backend panel. Full details:
[bridge/README.md](bridge/README.md).

Runtime repair status: full in-app runtime repair is not implemented yet. To repair manually, close
LumenDeck, delete `%LOCALAPPDATA%\LumenDeck\diffusers-runtime`, relaunch, then run **Install runtime +
model** again.

For common failure modes, see [docs/diagnostics.md](docs/diagnostics.md).

### Workflow Templates

The default ComfyUI workflow template lives in:

`src/turboForge/workflows/comfyWorkflowTemplates.ts`

It maps prompt, negative prompt, seed, steps, CFG, width, height, and checkpoint name into a minimal
text-to-image graph. ComfyUI checkpoint names must match files known to your ComfyUI
`models/checkpoints` folder. If your model is named differently, edit the template or select a model
id that maps to the right checkpoint filename.

## TurboForge

TurboForge helps workflows feel faster and fail less by planning renders before they start, caching
expensive setup decisions, warning about heavy settings, and recording benchmark history.

Presets:

- Safe: most reliable
- Fast: good default
- Turbo: faster if supported
- Forge: compile for max speed
- Eco: lower memory
- Draft: fast preview
- Final: high-quality export

TurboForge does not guarantee 2x speed. Measured speedup appears only after baseline and optimized
benchmark data exist for the selected workflow/backend.

Benchmarks distinguish:

- Mock/app timing
- Backend health-check timing
- Real backend request timing
- Render queue/wait timing where available
- Output fetch/download timing where available
- Total render time

Real model benchmarks require a connected backend and supported hardware.

## Manifests

Every gallery render stores a manifest with:

- Prompt, seed, sampler, canvas, model, LoRAs, and graph snapshot
- TurboForge preset and render plan
- Selected backend and backend health status
- Compile cache status and optimization flags
- Benchmark data when available
- Warnings and recommended fixes

## Support LumenDeck

LumenDeck is free, open source, and donation-supported. If it earns a place in your creative
toolkit, you can support development on Ko-fi:

**[Support LumenDeck on Ko-fi](https://ko-fi.com/mekhaneproductions)**

Donations fund installer builds, documentation, preset packs, constellation system improvements,
gradient engine and renderer polish, and long-term maintenance. Every core feature stays free and
open — donations are optional and never unlock a paywall. Prefer to help another way? See
[CONTRIBUTING.md](CONTRIBUTING.md) for bug reports, presets, docs, and code, and
[ROADMAP.md](ROADMAP.md) for where the project is heading.

## License

LumenDeck is licensed under the [Apache License 2.0](LICENSE).
Copyright 2026 MEKHANE Productions (Greg Molina).

## Git Remote

If `git push` says no push destination is configured, create or choose a remote repository, then run:

```bash
git remote add origin <REPO_URL>
git push -u origin main
```

Do not use a fake remote URL. Use the actual GitHub/GitLab/Bitbucket repository you want LumenDeck
pushed to.
