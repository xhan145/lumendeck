# TurboForge Setup Notes

TurboForge is LumenDeck's performance planning and benchmark layer.

## Mock Mode

Mock is always available. It is useful for:

- UI development
- Manifest and gallery testing
- No-GPU environments
- Checking that render planning and benchmark storage work

Mock timings are not real model benchmarks.

## ComfyUI Mode

ComfyUI mode is the first practical real-generation path.

Default URL:

`http://127.0.0.1:8188`

The adapter uses:

- `GET /system_stats` for health
- `POST /prompt` to queue a workflow
- `GET /history/{prompt_id}` to poll completion
- `GET /view?...` to fetch the output image

If the browser cannot reach ComfyUI because of network or CORS restrictions, LumenDeck reports the failure and can fall back to Mock.

## First Render

1. Start LumenDeck with `npm run dev -- --host 127.0.0.1`.
2. Open `http://127.0.0.1:5178/`.
3. Use Mock first and click Render.
4. Start ComfyUI.
5. Select ComfyUI API in Backend settings.
6. Click Test connection.
7. Make sure the workflow template checkpoint name exists in ComfyUI.
8. Render again.

## Model and Workflow Locations

LumenDeck's demo Model Shelf is local metadata. Real model files stay in your backend:

- ComfyUI checkpoints: ComfyUI `models/checkpoints`
- ComfyUI LoRAs: ComfyUI `models/loras`
- LumenDeck sample workflow template: `src/turboForge/workflows/comfyWorkflowTemplates.ts`

## Performance Honesty

TurboForge can reduce wasted renders and make workflows feel faster through preflight checks, draft-first settings, cached setup metadata, and backend-specific optimization flags.

It does not claim guaranteed speedups. Speedup is shown only from measured baseline and optimized benchmark timings.
