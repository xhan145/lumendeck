# LumenDeck Diagnostics

Use the Diagnostics page when generation does not produce a real model render. It shows bridge,
ComfyUI, Diffusers, CUDA, model folder, queue, fallback, and storage state in one copyable report.

## Common CUDA / Torch Failures

- **CUDA false or device cpu**: PyTorch did not find a CUDA-capable NVIDIA runtime. Use **Install runtime + model** from Diagnostics or Settings, then check again.
- **Torch install failure**: confirm Python 3.10-3.13 is available. Python 3.12 is the recommended target for the managed runtime.
- **CPU fallback**: SD-Turbo can run slowly on CPU, but SDXL/Pony-sized checkpoints usually need a GPU and may fall back to placeholder output.
- **Model cached false**: use **Download model** after dependencies are ready.

## Bridge Offline

The local bridge normally answers at `http://127.0.0.1:8787`.

- In the desktop app, the Tauri sidecar starts it automatically.
- In dev mode, use `npm run dev -- --host 127.0.0.1`.
- Check `/health` if you are debugging manually.
- Managed runtime logs are expected under `%LOCALAPPDATA%\LumenDeck\diffusers-runtime\worker.log` when the worker writes logs.

## ComfyUI Offline

ComfyUI must be running separately, usually at `http://127.0.0.1:8188`.

LumenDeck uses these endpoints:

- `/system_stats` for health
- `/prompt` to submit the workflow
- `/history/{prompt_id}` to poll completion
- `/view` to fetch output

Firewall, URL, CORS, or rejected-workflow errors should appear in Diagnostics and in the queue. If fallback is enabled, the render can complete as a placeholder and will be marked as fallback in Gallery.

## Model Folder Scan Issues

The bridge scanner supports `.safetensors`, `.ckpt`, `.pt`, and `.pth` files. ComfyUI/A1111-style folders work best.

Use **Model Shelf** to paste a folder path and scan it. Use **Refresh folder** and **Refresh shelf** in Diagnostics after changing folders.

## Fallback / Placeholder Output

A render is not clean success when:

- The queue says `done + warning`.
- The Gallery card has a **Fallback** badge.
- The Gallery drawer says LumenDeck used procedural/mock fallback.
- The manifest has `render.fallback: true`.

Use the fallback reason to decide whether to install the Diffusers runtime/model, restart ComfyUI, change URLs, or switch deliberately to Mock for a demo.

## Copying Diagnostics

Open **Diagnostics**, click **Copy diagnostics**, then paste the report into an issue or support thread. Tokens and common key patterns are redacted by the formatter.
