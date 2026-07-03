# LumenDeck Render Bridge

A tiny local FastAPI backend that gives LumenDeck a real text-to-image path and a
local model scanner. The default generator is a **pure-standard-library procedural
renderer** — no GPU, no Pillow, no numpy — so it runs anywhere and produces
deterministic, reproducible images from a seed. It is the reference implementation
of the `BackendAdapter` contract; swap in a real backend via `adapters.py`.

## Endpoints

| Method | Path        | Purpose                                             |
|--------|-------------|-----------------------------------------------------|
| GET    | `/health`   | `{ "status": "ok", "adapter": "procedural" }`       |
| GET    | `/models`   | `ModelAsset[]` — local scan or demo catalog         |
| POST   | `/generate` | `{ image_base64, seed }` from a render job          |

The front-end client is `src/bridge/httpAdapter.ts` (default `http://127.0.0.1:8787`).
Select **Diffusers bridge** in the Backend panel and set the URL to match.

## Run

```bash
cd bridge
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8787
```

## Scan local models

Point the bridge at a models folder; it walks the tree for
`.safetensors/.ckpt/.pt/.pth`, hashes each file, and infers family from the name.
Files under a `lora`/`loras` folder are tagged as LoRAs.

```bash
# Windows
set LUMENDECK_MODEL_DIR=C:\path\to\models
# macOS/Linux
export LUMENDECK_MODEL_DIR=/path/to/models
```

With no directory set (or an empty one) `/models` returns the demo catalog.

## Test

```bash
pytest            # if installed
python test_renderer.py   # standalone, no pytest needed
```

## Plug in a real backend

`adapters.py` defines `GeneratorAdapter` (ABC) with `ProceduralAdapter` and a
documented `A1111Adapter` stub. Implement `A1111Adapter.generate` against a running
AUTOMATIC1111 WebUI (`/sdapi/v1/txt2img`), then set `adapter = A1111Adapter()` in
`main.py`. The front-end also ships a ComfyUI adapter (`src/bridge/comfyAdapter.ts`)
that talks directly to a local ComfyUI server if you prefer that route.
