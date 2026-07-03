# LumenDeck

LumenDeck is a local-first, node-native generative image studio shell. It includes Recipe View, Graph View, Model Shelf, LoRA Rack, Gallery, and TurboForge performance planning.

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

## Backends

### Mock Backend

The Mock backend is built in and needs no GPU. It creates deterministic procedural images so you can test prompts, manifests, gallery restore, TurboForge planning, benchmark storage, and UI flow.

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

The ComfyUI path checks `/system_stats`, submits a workflow to `/prompt`, polls `/history/{prompt_id}`, and fetches the output via `/view`.

If ComfyUI is offline, blocked by CORS, or rejects the sample workflow, LumenDeck shows a plain-English error. If `Fallback to mock` is enabled, the app renders with Mock instead and records the fallback in the manifest warning data.

### Workflow Templates

The default ComfyUI workflow template lives in:

`src/turboForge/workflows/comfyWorkflowTemplates.ts`

It maps prompt, negative prompt, seed, steps, CFG, width, height, and checkpoint name into a minimal text-to-image graph. ComfyUI checkpoint names must match files known to your ComfyUI `models/checkpoints` folder. If your model is named differently, edit the template or select a model id that maps to the right checkpoint filename.

## TurboForge

TurboForge helps workflows feel faster and fail less by planning renders before they start, caching expensive setup decisions, warning about heavy settings, and recording benchmark history.

Presets:

- Safe: most reliable
- Fast: good default
- Turbo: faster if supported
- Forge: compile for max speed
- Eco: lower memory
- Draft: fast preview
- Final: high-quality export

TurboForge does not guarantee 2x speed. Measured speedup appears only after baseline and optimized benchmark data exist for the selected workflow/backend.

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

## Git Remote

If `git push` says no push destination is configured, create or choose a remote repository, then run:

```bash
git remote add origin <REPO_URL>
git push -u origin main
```

Do not use a fake remote URL. Use the actual GitHub/GitLab/Bitbucket repository you want LumenDeck pushed to.
