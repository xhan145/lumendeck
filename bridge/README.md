# LumenDeck Render Bridge

A tiny local backend that gives LumenDeck a real text-to-image path and a local model scanner. It has
two servers that share the same route contract:

- **`server.py` - pure Python standard library**. This is what the desktop app bundles:
  `build_sidecar.py` freezes it with PyInstaller into a single exe the Tauri app auto-starts. No
  Python server setup is needed on the user's machine.
- **`main.py` - FastAPI**. Optional for local development with hot docs/validation. Deprecated in
  favor of `server.py`; kept for convenience. Needs `pip install -r requirements.txt`.

The default generator is a **pure-stdlib procedural renderer** (`renderer.py`): no GPU, no Pillow, no
numpy, deterministic and reproducible from a seed, so it runs anywhere. An optional **real** path
(`diffusers_backend.py`, SD-Turbo) activates only if `torch` and `diffusers` are importable.

## Endpoints

| Method | Path                  | Purpose                                                                  |
|--------|-----------------------|--------------------------------------------------------------------------|
| GET    | `/health`             | `{ "status":"ok", "adapter":"procedural", "diffusers":bool, "model":... }` |
| GET    | `/models`             | `ModelAsset[]` - local scan or demo catalog                              |
| GET    | `/diffusers/status`   | Diffusers dependency, cache, device, and model readiness                  |
| POST   | `/diffusers/download` | Downloads/loads the configured Diffusers model into the HF cache          |
| POST   | `/generate`           | `{ image_base64, seed }` - body may set `renderer` (see below)            |

`POST /generate` accepts a `renderer` field: `"procedural"` (always), `"diffusers"` (real SD-Turbo;
503 if torch/diffusers are absent), or `"auto"` (diffusers if available, else procedural).

Front-end client: `src/bridge/httpAdapter.ts` (default `http://127.0.0.1:8787`). In the desktop app
the sidecar starts automatically; select **Diffusers bridge** in the Backend panel to use it, and pick
the renderer mode there.

## Run (stdlib - no install)

```bash
cd bridge
python server.py --port 8787
```

## Run (FastAPI dev - optional)

```bash
cd bridge && pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8787
```

## Build the desktop sidecar

```bash
pip install pyinstaller
python bridge/build_sidecar.py
# -> src-tauri/binaries/lumendeck-bridge-x86_64-pc-windows-msvc.exe
```

## Enable real diffusion (SD-Turbo)

Install the optional packages on the bridge host:

```bash
python -m pip install torch diffusers transformers accelerate
```

With those present, `/health` reports `"diffusers": true`. The app's Backend panel can call:

```text
GET  /diffusers/status
POST /diffusers/download
```

The download route loads `stabilityai/sd-turbo`, which downloads weights to the Hugging Face cache.
After that, `renderer:"auto"` or `renderer:"diffusers"` runs a real SD-Turbo pipeline. CPU works but
is slow; a CUDA GPU is much faster.

Set `LUMENDECK_DIFFUSERS_MODEL` before starting the bridge to use a different Diffusers-compatible
text-to-image model id.

## Scan local models

Point the bridge at a models folder; it walks the tree for `.safetensors/.ckpt/.pt/.pth`, hashes each
file, and infers family from the name. Files under a `lora`/`loras` folder are tagged as LoRAs.

```bash
# Windows
set LUMENDECK_MODEL_DIR=C:\path\to\models
# macOS/Linux
export LUMENDECK_MODEL_DIR=/path/to/models
```

With no directory set (or an empty one) `/models` returns the demo catalog.

## Test

```bash
python test_server.py            # stdlib server routes (no pytest needed)
python test_renderer.py          # procedural renderer determinism
python test_diffusers_backend.py # diffusers availability/guard
pytest                           # runs all of the above if installed
```

## Plug in another real backend

`adapters.py` defines `GeneratorAdapter` (ABC) with `ProceduralAdapter` and a documented
`A1111Adapter` stub. The front-end also ships a ComfyUI adapter (`src/bridge/comfyAdapter.ts`) that
talks directly to a local ComfyUI server.
