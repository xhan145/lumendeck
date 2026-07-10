# Temporal Coherence — Phase 1 (SVD "Animate this render") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Stable Video Diffusion image-to-video — an "Animate this render" action that turns a gallery still into a short, coherent H.264 clip, using a locally-provided SVD model, with honest guardrails and no silent fallback.

**Architecture:** A new bridge worker fn `_animate_svd` (inside `_WORKER_SOURCE`) loads `StableVideoDiffusionPipeline` from a local model, animates the still, and encodes H.264 via the existing `_encode_sequence`. A module-level `animate_svd` forwarder + `find_svd_models` expose it; `server.py` gets `/animate-svd` + `/svd-models`. The TS `animateStill` adapter method (http/mock/comfy), a store thunk, and a Gallery-drawer "Animate" panel complete the path.

**Tech Stack:** Python 3 (stdlib bridge + managed cp314 diffusers runtime), TypeScript, React 18, Zustand, Vite 6, Vitest, pytest.

## Global Constraints

- **Version target:** bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` to **0.27.0** (`tests/versionSync.test.ts` guards parity with `APP_VERSION`).
- **Two-copy discipline:** the code the worker actually runs lives inside the `_WORKER_SOURCE` raw string (`r'''` at `bridge/diffusers_backend.py:58`, closing at `:1158`). Helpers used only by the worker (`_animate_svd`, `clamp_svd_params`, `svd_target_size`) live INSIDE that string and are tested by `exec`-ing the source (like the existing motion worker-source tests). Helpers used by the module/server (`find_svd_models`, `is_svd_model`, `animate_svd` forwarder) live module-level and are tested directly.
- **No silent fallback (LumenDeck ethos):** SVD failures (no model, OOM, diffusers missing) surface as loud, specific errors — NEVER a fake/procedural SVD clip. The mock backend returns an explicitly-labeled mock, never a pretend-SVD.
- **Local-folder model:** SVD is discovered from the models dir (diffusers folder with `model_index.json` `_class_name === "StableVideoDiffusionPipeline"`, or `svd*.safetensors`). No in-app download / HF token.
- **Conservative defaults:** 14 frames, `decode_chunk_size` 2, CPU-offload; SVD sizes are 1024×576 (landscape) / 576×1024 (portrait) only.
- **Verifiability note:** the actual SVD generation can NOT run in CI or this environment (no model, no GPU). All pure helpers, the TS adapter/store, and the mock path ARE unit-tested; the `_animate_svd` body is written correct-by-construction mirroring the working `_animate`. The real clip is a manual e2e gated on a local model.
- **No public MSI release** until the user explicitly says "release".

---

### Task 1: Pure SVD helpers (module-level) + tests

**Files:**
- Modify: `bridge/diffusers_backend.py` (add module-level helpers after `model_id()` ~line 1161)
- Test: `bridge/test_svd.py`

**Interfaces:**
- Produces (module-level):
  - `svd_target_size(width:int, height:int) -> tuple[int,int]` — landscape(w≥h)→(1024,576), portrait→(576,1024); non-positive→(1024,576).
  - `clamp_svd_params(job:dict) -> dict` — `{num_frames(8..25,def14), fps(1..30,def7), motion_bucket_id(1..255,def127), noise_aug_strength(0.0..1.0,def0.02), decode_chunk_size(1..8,def2), seed(>=0,def0)}`.
  - `is_svd_model(path:str) -> bool` — a dir whose `model_index.json` has `_class_name=="StableVideoDiffusionPipeline"`, OR a file matching `svd*.safetensors`/`*svd*img2vid*.safetensors` (case-insensitive).
  - `find_svd_models(models_dir:str) -> list[dict]` — `[{id, name, path, kind:'folder'|'file'}]` for each SVD model found one level under `models_dir` (dirs) + top-level `*.safetensors` files; `[]` if the dir is missing.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test_svd.py`:

```python
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import diffusers_backend as db


def test_svd_target_size_orientation():
    assert db.svd_target_size(1200, 800) == (1024, 576)   # landscape
    assert db.svd_target_size(800, 1200) == (576, 1024)   # portrait
    assert db.svd_target_size(1000, 1000) == (1024, 576)  # square -> landscape default
    assert db.svd_target_size(0, 0) == (1024, 576)         # degenerate -> default


def test_clamp_svd_params_defaults_and_bounds():
    d = db.clamp_svd_params({})
    assert d["num_frames"] == 14 and d["fps"] == 7 and d["motion_bucket_id"] == 127
    assert d["decode_chunk_size"] == 2 and d["seed"] == 0
    hi = db.clamp_svd_params({"num_frames": 999, "fps": 999, "motion_bucket_id": 999, "decode_chunk_size": 999, "seed": -5})
    assert hi["num_frames"] == 25 and hi["fps"] == 30 and hi["motion_bucket_id"] == 255
    assert hi["decode_chunk_size"] == 8 and hi["seed"] == 0
    lo = db.clamp_svd_params({"num_frames": 1, "fps": 0, "motion_bucket_id": 0, "decode_chunk_size": 0})
    assert lo["num_frames"] == 8 and lo["fps"] == 1 and lo["motion_bucket_id"] == 1 and lo["decode_chunk_size"] == 1


def test_is_svd_model_folder(tmp_path):
    d = tmp_path / "svd-img2vid"
    d.mkdir()
    (d / "model_index.json").write_text(json.dumps({"_class_name": "StableVideoDiffusionPipeline"}))
    assert db.is_svd_model(str(d)) is True
    other = tmp_path / "sdxl"
    other.mkdir()
    (other / "model_index.json").write_text(json.dumps({"_class_name": "StableDiffusionXLPipeline"}))
    assert db.is_svd_model(str(other)) is False


def test_is_svd_model_singlefile(tmp_path):
    f = tmp_path / "svd_xt.safetensors"
    f.write_bytes(b"x")
    assert db.is_svd_model(str(f)) is True
    g = tmp_path / "dreamshaper.safetensors"
    g.write_bytes(b"x")
    assert db.is_svd_model(str(g)) is False


def test_find_svd_models(tmp_path):
    (tmp_path / "svd-img2vid").mkdir()
    (tmp_path / "svd-img2vid" / "model_index.json").write_text(json.dumps({"_class_name": "StableVideoDiffusionPipeline"}))
    (tmp_path / "svd.safetensors").write_bytes(b"x")
    (tmp_path / "notmodel").mkdir()
    found = db.find_svd_models(str(tmp_path))
    paths = {os.path.basename(m["path"]) for m in found}
    assert "svd-img2vid" in paths and "svd.safetensors" in paths
    assert all("id" in m and "name" in m and m["kind"] in ("folder", "file") for m in found)
    assert db.find_svd_models(str(tmp_path / "missing")) == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd bridge && python -m pytest test_svd.py -q`
Expected: FAIL — `svd_target_size`/`clamp_svd_params`/`is_svd_model`/`find_svd_models` don't exist.

- [ ] **Step 3: Implement the helpers (module-level)**

In `bridge/diffusers_backend.py`, after `def model_id(): return _MODEL_ID` (~line 1162), add:

```python
def svd_target_size(width, height):
    """SVD is trained only at 1024x576 (landscape) and 576x1024 (portrait). Snap by
    orientation; square/degenerate defaults to landscape."""
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        return (1024, 576)
    if w <= 0 or h <= 0:
        return (1024, 576)
    return (576, 1024) if h > w else (1024, 576)


def clamp_svd_params(job):
    """Clamp SVD params to safe ranges with conservative 8GB-friendly defaults."""
    def _i(key, default, lo, hi):
        try:
            v = int(job.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))
    try:
        naug = float(job.get("noise_aug_strength", 0.02))
    except (TypeError, ValueError):
        naug = 0.02
    naug = max(0.0, min(1.0, naug))
    seed = _i("seed", 0, 0, 2**31 - 1)
    return {
        "num_frames": _i("num_frames", 14, 8, 25),
        "fps": _i("fps", 7, 1, 30),
        "motion_bucket_id": _i("motion_bucket_id", 127, 1, 255),
        "noise_aug_strength": naug,
        "decode_chunk_size": _i("decode_chunk_size", 2, 1, 8),
        "seed": seed,
    }


def is_svd_model(path):
    """True for an SVD diffusers folder (model_index.json class) or an svd*.safetensors."""
    try:
        if os.path.isdir(path):
            idx = os.path.join(path, "model_index.json")
            if os.path.isfile(idx):
                with open(idx, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                return data.get("_class_name") == "StableVideoDiffusionPipeline"
            return False
        name = os.path.basename(path).lower()
        if not name.endswith(".safetensors"):
            return False
        return name.startswith("svd") or ("svd" in name and "img2vid" in name)
    except (OSError, ValueError):
        return False


def find_svd_models(models_dir):
    """Discover SVD models one level under models_dir (folders) + top-level files."""
    out = []
    try:
        entries = sorted(os.listdir(models_dir))
    except OSError:
        return out
    for name in entries:
        full = os.path.join(models_dir, name)
        if is_svd_model(full):
            out.append({
                "id": name,
                "name": name,
                "path": full,
                "kind": "folder" if os.path.isdir(full) else "file",
            })
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd bridge && python -m pytest test_svd.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add bridge/diffusers_backend.py bridge/test_svd.py
git commit -m "feat(svd): pure SVD helpers — target size, param clamp, model detection"
```

---

### Task 2: `_animate_svd` worker fn + dispatch + module forwarder

**Files:**
- Modify: `bridge/diffusers_backend.py` — inside `_WORKER_SOURCE` (add `_animate_svd` + helpers near `_animate` ~line 368; add `animate_svd` command in the serve loop ~line 1116 and the one-shot `main()` ~line 1152); add a module-level `animate_svd(payload)` forwarder + `svd_status()` near `render_motion` (~line 1961).
- Test: `bridge/test_svd.py` (append a worker-source-exec parity test)

**Interfaces:**
- Consumes: `clamp_svd_params`, `svd_target_size` (mirrored inside the worker string); `_encode_sequence` (worker copy); `_persistent_worker` / `_worker` (module).
- Produces (module-level): `animate_svd(payload:dict) -> dict` (forwards to the worker `animate_svd` command; raises on error); `svd_status() -> dict` = `{ models: find_svd_models(discover_model_dir()) }` using the existing model-dir resolver.

- [ ] **Step 1: Add `_animate_svd` + mirrored helpers INSIDE `_WORKER_SOURCE`**

In `bridge/diffusers_backend.py`, inside the `_WORKER_SOURCE` string, right after the `_animate` function (the `return {...}` block that ends ~line 368, before `_CONTROL_TYPES`), add:

```python

def _svd_target_size(width, height):
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        return (1024, 576)
    if w <= 0 or h <= 0:
        return (1024, 576)
    return (576, 1024) if h > w else (1024, 576)


def _clamp_svd(job):
    def _i(key, default, lo, hi):
        try:
            v = int(job.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))
    try:
        naug = float(job.get("noise_aug_strength", 0.02))
    except (TypeError, ValueError):
        naug = 0.02
    return {
        "num_frames": _i("num_frames", 14, 8, 25),
        "fps": _i("fps", 7, 1, 30),
        "motion_bucket_id": _i("motion_bucket_id", 127, 1, 255),
        "noise_aug_strength": max(0.0, min(1.0, naug)),
        "decode_chunk_size": _i("decode_chunk_size", 2, 1, 8),
        "seed": _i("seed", 0, 0, 2**31 - 1),
    }


def _load_svd_pipe(model_path):
    import torch
    from diffusers import StableVideoDiffusionPipeline
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    if os.path.isdir(model_path):
        pipe = StableVideoDiffusionPipeline.from_pretrained(model_path, torch_dtype=dtype, variant="fp16")
    else:
        pipe = StableVideoDiffusionPipeline.from_single_file(model_path, torch_dtype=dtype)
    for enable in ("enable_vae_slicing", "enable_vae_tiling", "enable_attention_slicing"):
        try:
            getattr(pipe, enable)()
        except Exception:
            pass
    if torch.cuda.is_available():
        try:
            pipe.enable_model_cpu_offload()
        except Exception:
            pipe = pipe.to("cuda")
    else:
        pipe = pipe.to("cpu")
    return pipe


def _animate_svd(job, state, report):
    """Real image->video via Stable Video Diffusion, encoded H.264. Loud on OOM/missing."""
    import base64 as _b64
    import io as _io
    import torch
    from PIL import Image
    model_path = job.get("modelPath")
    if not model_path or not os.path.exists(model_path):
        raise RuntimeError("No SVD model found. Put a Stable Video Diffusion model in your models folder.")
    key = "svd:" + str(model_path)
    if state.get("svd_key") != key or state.get("svd_pipe") is None:
        report({"phase": "loading"})
        state["pipe"] = None
        state["key"] = None
        state["anim_pipe"] = None
        state["anim_key"] = None
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        state["svd_pipe"] = _load_svd_pipe(model_path)
        state["svd_key"] = key
    pipe = state["svd_pipe"]

    raw = job.get("image", "")
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        image = Image.open(_io.BytesIO(_b64.b64decode(raw))).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"Could not decode the input image: {exc}")
    tw, th = _svd_target_size(image.width, image.height)
    # center-crop to the target aspect, then resize (no distortion)
    src_ar, dst_ar = image.width / image.height, tw / th
    if src_ar > dst_ar:
        nw = int(image.height * dst_ar)
        left = (image.width - nw) // 2
        image = image.crop((left, 0, left + nw, image.height))
    else:
        nh = int(image.width / dst_ar)
        top = (image.height - nh) // 2
        image = image.crop((0, top, image.width, top + nh))
    image = image.resize((tw, th))

    p = _clamp_svd(job)
    gen_device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = torch.Generator(device=gen_device).manual_seed(p["seed"])
    report({"phase": "rendering", "step": 0, "steps": p["num_frames"]})

    def on_step(_pipe, step, _timestep, callback_kwargs):
        report({"phase": "rendering", "step": int(step) + 1, "steps": p["num_frames"]})
        return callback_kwargs

    kwargs = dict(
        image=image,
        num_frames=p["num_frames"],
        motion_bucket_id=p["motion_bucket_id"],
        noise_aug_strength=p["noise_aug_strength"],
        decode_chunk_size=p["decode_chunk_size"],
        generator=generator,
    )
    try:
        try:
            result = pipe(**kwargs, callback_on_step_end=on_step)
        except TypeError:
            result = pipe(**kwargs)
    except torch.cuda.OutOfMemoryError:
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        state["svd_pipe"] = None
        state["svd_key"] = None
        raise RuntimeError("Not enough VRAM for SVD at these settings — try fewer frames or a smaller decode chunk.")
    frames = result.frames[0]
    report({"phase": "decoding"})
    encoded = _encode_sequence([f.convert("RGB") for f in frames], p["fps"], "mp4", loop=False)
    report({"phase": "done"})
    return {**encoded, "seed": p["seed"], "frameCount": len(frames), "fps": p["fps"], "engine": "svd"}
```

- [ ] **Step 2: Wire the `animate_svd` command into the worker dispatch (both places, INSIDE `_WORKER_SOURCE`)**

In the `serve()` loop dispatch, after the `render_sequence` branch (`elif command == "render_sequence": out = do_render_sequence(payload, state)`), add:

```python
            elif command == "animate_svd":
                progress_path = payload.get("progressPath")
                def _rep(data, _p=progress_path):
                    if not _p:
                        return
                    try:
                        with open(_p, "w", encoding="utf-8") as fh:
                            json.dump(data, fh)
                    except OSError:
                        pass
                out = _animate_svd(payload, state, _rep)
```

In `main()` (the one-shot path), after the `render_sequence` branch, add:

```python
    if command == "animate_svd":
        payload = json.load(sys.stdin)
        out = _animate_svd(payload, {"pipe": None, "key": None, "lora_key": None}, lambda _d: None)
        print(json.dumps(out))
        return
```

- [ ] **Step 3: Add the module-level `animate_svd` forwarder + `svd_status`**

After the module-level `render_motion(payload)` function (ends ~line 1961), add:

```python
def animate_svd(payload: dict) -> dict:
    """Image->video via SVD on the resident worker. Raises loudly on error."""
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    if not payload.get("image"):
        raise RuntimeError("animate_svd needs an 'image'")
    if not payload.get("modelPath"):
        raise RuntimeError("No SVD model selected. Put a Stable Video Diffusion model in your models folder.")
    try:
        out = _persistent_worker.request("animate_svd", payload, timeout=3600)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("animate_svd", payload, timeout=3600)
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(out["error"])
    return out


def svd_status() -> dict:
    """List locally-available SVD models (for the app's Animate action)."""
    try:
        models_dir = discover_model_dir()
    except Exception:
        return {"models": []}
    return {"models": find_svd_models(models_dir) if models_dir else []}
```

(If `discover_model_dir` is named differently in this file, use the existing model-dir resolver — grep `def discover_model_dir` / `model_dir`; `server.py` calls `discover_model_dir()` at line 643, so it exists.)

- [ ] **Step 4: Add a worker-source parity test (append to `bridge/test_svd.py`)**

```python
def test_worker_source_defines_svd_helpers():
    # The code that ACTUALLY runs SVD lives inside the _WORKER_SOURCE string; exec it
    # in an isolated namespace and check the helpers exist + clamp identically to the
    # module-level copy (the two must stay in sync).
    ns = {}
    exec(compile(db._WORKER_SOURCE, "<worker>", "exec"), ns)
    assert "_animate_svd" in ns and callable(ns["_animate_svd"])
    assert ns["_svd_target_size"](800, 1200) == (576, 1024)
    assert ns["_svd_target_size"](1200, 800) == (1024, 576)
    got = ns["_clamp_svd"]({"num_frames": 999, "fps": 0})
    assert got["num_frames"] == 25 and got["fps"] == 1 and got["motion_bucket_id"] == 127
```

- [ ] **Step 5: Run + verify**

Run: `cd bridge && python -m pytest test_svd.py -q`
Expected: PASS (6 tests). The worker source compiles and the SVD helpers/clamp match the module copy.

- [ ] **Step 6: Commit**

```bash
git add bridge/diffusers_backend.py bridge/test_svd.py
git commit -m "feat(svd): _animate_svd worker fn + animate_svd command/forwarder + parity test"
```

---

### Task 3: `server.py` — `/animate-svd` + `/svd-models` endpoints

**Files:**
- Modify: `bridge/server.py` (add both routes to `API_PREFIXES` ~line 46 and handlers near the `/render-motion` handler ~line 613)

**Interfaces:**
- Consumes: `diffusers_backend.animate_svd`, `diffusers_backend.svd_status`, the existing progress helpers (`_progress_path`, `_write_progress`, `_JOB_ID`).
- Produces: HTTP `GET /svd-models -> { models: [...] }`; `POST /animate-svd { image, modelPath, ...params, jobId? } -> RenderResult json` or `{ error }` (loud — NO procedural fallback).

- [ ] **Step 1: Register the routes**

In `bridge/server.py`, extend `API_PREFIXES` (line 46) to include the new paths:

```python
API_PREFIXES = ("/health", "/models", "/svd-models", "/model-folder", "/generate", "/render-motion", "/animate-svd", "/evolve-step", "/diffusers", "/progress", "/civitai", "/controlnet")
```

- [ ] **Step 2: Add the GET `/svd-models` handler**

In the request dispatch, next to the `GET /models` handler (~line 412), add:

```python
    if method == "GET" and path == "/svd-models":
        headers["Content-Type"] = "application/json"
        try:
            return 200, headers, json.dumps(diffusers_backend.svd_status()).encode()
        except Exception as exc:
            return 200, headers, json.dumps({"models": [], "error": str(exc)}).encode()
```

- [ ] **Step 3: Add the POST `/animate-svd` handler (loud, no procedural fallback)**

After the `/render-motion` handler block (ends ~line 666), add:

```python
    if method == "POST" and path == "/animate-svd":
        headers["Content-Type"] = "application/json"
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        if not payload.get("image"):
            return 400, headers, json.dumps({"error": "image is required"}).encode()
        if not _diffusers_available():
            return 200, headers, json.dumps({"error": "Real diffusion isn't ready on the bridge (torch/model not installed)."}).encode()
        job_id = str(payload.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        if track:
            _prune_progress_files()
            payload["progressPath"] = _progress_path(job_id)
            _write_progress(job_id, {"phase": "loading"})
        try:
            result = diffusers_backend.animate_svd(payload)
            if track:
                _write_progress(job_id, {"phase": "done"})
            return 200, headers, json.dumps(result).encode()
        except Exception as exc:
            import traceback
            traceback.print_exc()
            if track:
                _write_progress(job_id, {"phase": "done"})
            # SVD has NO honest procedural equivalent — surface the error, never a fake clip.
            return 200, headers, json.dumps({"error": str(exc)}).encode()
```

- [ ] **Step 4: Verify the bridge imports cleanly**

Run: `cd bridge && python -c "import server; import diffusers_backend; print('ok', hasattr(diffusers_backend,'animate_svd'), hasattr(diffusers_backend,'svd_status'))"`
Expected: `ok True True` (no import/syntax error).

- [ ] **Step 5: Commit**

```bash
git add bridge/server.py
git commit -m "feat(svd): /animate-svd + /svd-models bridge endpoints (loud, no procedural fallback)"
```

---

### Task 4: TS adapter — `animateStill` + `svdModels` (http/mock/comfy)

**Files:**
- Modify: `src/bridge/adapter.ts` (add `AnimateStillOptions`, `SvdModelInfo`, interface methods `animateStill` + `listSvdModels`)
- Modify: `src/bridge/httpAdapter.ts`, `src/bridge/mockAdapter.ts`, `src/bridge/comfyAdapter.ts`
- Test: `tests/animateStill.test.ts`

**Interfaces:**
- Produces:
  - `interface SvdModelInfo { id: string; name: string; path: string; kind: 'folder'|'file' }`
  - `interface AnimateStillOptions { frames: number; fps: number; motion: number; seed: number; modelPath: string; jobId?: string }`
  - `BackendAdapter.animateStill(imageBase64: string, opts: AnimateStillOptions, onProgress?: RenderProgressCallback): Promise<RenderResult>`
  - `BackendAdapter.listSvdModels(): Promise<SvdModelInfo[]>`

- [ ] **Step 1: Write the failing tests**

Create `tests/animateStill.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { HttpAdapter } from '../src/bridge/httpAdapter';
import { MockAdapter } from '../src/bridge/mockAdapter';

const OPTS = { frames: 14, fps: 7, motion: 127, seed: 0, modelPath: '/models/svd', jobId: 'abcabcabcabc' };

describe('httpAdapter.animateStill', () => {
  it('POSTs {image,modelPath,...} to /animate-svd and maps the mp4 result', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/progress/')) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ video_base64: 'AAA', mediaType: 'video', mimeType: 'video/mp4', extension: 'mp4', seed: 5, engine: 'svd' }), { status: 200 });
    });
    const a = new HttpAdapter('http://localhost:8787', fetchMock as unknown as typeof fetch);
    const r = await a.animateStill('BASE64IMG', OPTS);
    expect(r.mediaType).toBe('video');
    expect(r.mimeType).toBe('video/mp4');
    expect(r.dataUrl.startsWith('data:video/mp4;base64,')).toBe(true);
    const postCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/animate-svd'))!;
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    // The adapter maps the UI names -> the worker's clamp keys (num_frames / motion_bucket_id).
    expect(body).toMatchObject({ image: 'BASE64IMG', modelPath: '/models/svd', num_frames: 14, fps: 7, motion_bucket_id: 127 });
  });

  it('throws loudly when the bridge returns an error (no silent success)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/progress/')) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ error: 'Not enough VRAM for SVD at these settings.' }), { status: 200 });
    });
    const a = new HttpAdapter('http://localhost:8787', fetchMock as unknown as typeof fetch);
    await expect(a.animateStill('IMG', OPTS)).rejects.toThrow(/VRAM/);
  });

  it('listSvdModels GETs /svd-models', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [{ id: 's', name: 's', path: '/m/s', kind: 'folder' }] }), { status: 200 }));
    const a = new HttpAdapter('http://localhost:8787', fetchMock as unknown as typeof fetch);
    const models = await a.listSvdModels();
    expect(models).toHaveLength(1);
    expect(models[0].path).toBe('/m/s');
  });
});

describe('mockAdapter.animateStill', () => {
  it('returns an honest labeled mock video (never pretends to be SVD)', async () => {
    const r = await new MockAdapter().animateStill('IMG', OPTS);
    expect(r.mediaType).toBe('video');
    expect(r.fallback).toBe(true);
    expect(r.fallbackReason ?? '').toMatch(/mock|SVD|real backend/i);
  });
  it('mock listSvdModels is empty', async () => {
    expect(await new MockAdapter().listSvdModels()).toEqual([]);
  });
});
```

(Confirm the `HttpAdapter`/`MockAdapter` constructor signatures match — grep `class HttpAdapter` / `class MockAdapter`; if `HttpAdapter` takes `(base, fetchImpl?)` use that, else adapt the test to the actual ctor.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/animateStill.test.ts`
Expected: FAIL — `animateStill`/`listSvdModels` not defined.

- [ ] **Step 3: Add types + interface methods in `src/bridge/adapter.ts`**

After `RenderMotionOptions` (~line 96), add:

```ts
/** A locally-discovered Stable Video Diffusion model. */
export interface SvdModelInfo {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'file';
}

/** Options for animating a still into a coherent clip via SVD. */
export interface AnimateStillOptions {
  frames: number;
  fps: number;
  /** motion amount (SVD motion_bucket_id, 1..255). */
  motion: number;
  seed: number;
  /** absolute path of the SVD model to use (from listSvdModels). */
  modelPath: string;
  /** stable id for progress polling; adapters mint one when omitted. */
  jobId?: string;
}
```

In the `BackendAdapter` interface (after `renderMotion(...)`), add:

```ts
  /**
   * Animate a still image into a short coherent clip via Stable Video Diffusion.
   * `imageBase64` is the raw base64 (no data: prefix). Returns a video `RenderResult`.
   * Throws loudly on any backend error (missing model, OOM). The mock backend returns
   * an explicitly-labeled placeholder — never a pretend-SVD clip.
   */
  animateStill(imageBase64: string, opts: AnimateStillOptions, onProgress?: RenderProgressCallback): Promise<RenderResult>;
  /** Locally-available SVD models (empty on backends that can't run SVD). */
  listSvdModels(): Promise<SvdModelInfo[]>;
```

- [ ] **Step 4: Implement in `httpAdapter.ts`**

Add the imports `AnimateStillOptions, SvdModelInfo` to the type import block. Add these methods to the class (mirror `renderMotion`'s progress polling):

```ts
  async listSvdModels(): Promise<SvdModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.base}/svd-models`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: SvdModelInfo[] };
      return Array.isArray(data.models) ? data.models : [];
    } catch {
      return [];
    }
  }

  async animateStill(imageBase64: string, opts: AnimateStillOptions, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    const jobId = opts.jobId
      ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`);
    onProgress?.({ progress: 0.02, phase: 'queued' });
    let polling = Boolean(onProgress);
    const pollLoop = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 700));
        if (!polling) break;
        try {
          const res = await this.fetchImpl(`${this.base}/progress/${jobId}`, { signal: AbortSignal.timeout(1200) });
          if (!res.ok) continue;
          const p = (await res.json()) as { phase?: string; step?: number; steps?: number };
          if (p.phase === 'loading') onProgress?.({ progress: 0.05, phase: 'loading', detail: 'Loading SVD…' });
          else if (p.phase === 'rendering' && p.steps) onProgress?.({ progress: Math.min(0.95, 0.05 + 0.9 * ((p.step ?? 0) / p.steps)), phase: 'rendering', detail: `Step ${p.step ?? 0}/${p.steps}` });
          else if (p.phase === 'decoding') onProgress?.({ progress: 0.97, phase: 'decoding', detail: 'Decoding frames…' });
        } catch { /* advisory */ }
      }
    };
    if (polling) void pollLoop();
    try {
      const res = await this.fetchImpl(`${this.base}/animate-svd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Map the UI option names to the worker's clamp keys so the values actually take effect.
        body: JSON.stringify({ image: imageBase64, modelPath: opts.modelPath, num_frames: opts.frames, fps: opts.fps, motion_bucket_id: opts.motion, seed: opts.seed, jobId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Bridge /animate-svd failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { video_base64?: string; error?: string; mediaType?: 'video'; mimeType?: string; extension?: string; seed?: number | string };
      if (data.error) throw new Error(data.error);
      if (!data.video_base64) throw new Error('Bridge /animate-svd response did not include video data.');
      const mimeType = data.mimeType ?? 'video/mp4';
      const dataUrl = `data:${mimeType};base64,${data.video_base64}`;
      onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
      return { dataUrl, mediaType: 'video', mimeType, extension: data.extension ?? 'mp4', seed: Number(data.seed ?? opts.seed) };
    } finally {
      polling = false;
    }
  }
```

(Use the class's actual fetch handle — grep the class for `this.fetchImpl` vs `fetch`; `renderMotion` above uses bare `fetch`, so if there is no `this.fetchImpl`, accept a `fetchImpl` ctor param or use `fetch` and inject via the test's global. Simplest: add a `private fetchImpl: typeof fetch = fetch` ctor param to `HttpAdapter` if absent, matching the test.)

- [ ] **Step 5: Implement honest mock in `mockAdapter.ts`**

Add to the class (reuse the existing mock-video SVG helper used by `renderMotion`):

```ts
  async listSvdModels(): Promise<SvdModelInfo[]> {
    return [];
  }

  async animateStill(_imageBase64: string, opts: AnimateStillOptions): Promise<RenderResult> {
    // The built-in mock backend cannot run SVD — return an explicitly-labeled clip.
    const w = 512, h = 288;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#1a1030"/><circle cx="${w / 2}" cy="${h / 2}" r="40" fill="#7a5cff"><animate attributeName="r" values="30;50;30" dur="2s" repeatCount="indefinite"/></circle><text x="${w / 2}" y="${h - 16}" fill="#cbb8ff" font-family="sans-serif" font-size="13" text-anchor="middle">mock — SVD needs a real backend + model</text></svg>`;
    const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    return { dataUrl, mediaType: 'video', mimeType: 'image/svg+xml', extension: 'svg', seed: opts.seed, fallback: true, fallbackReason: 'Mock backend can’t run SVD — connect a real backend and add a Stable Video Diffusion model.' };
  }
```

Add `AnimateStillOptions, SvdModelInfo` to mockAdapter's type imports.

- [ ] **Step 6: Implement unsupported in `comfyAdapter.ts`**

```ts
  async listSvdModels(): Promise<SvdModelInfo[]> {
    return [];
  }

  async animateStill(_imageBase64: string, _opts: AnimateStillOptions): Promise<RenderResult> {
    throw new Error('The ComfyUI backend does not support SVD animate yet.');
  }
```

Add the type imports.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run tests/animateStill.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (all three adapters implement the two new interface methods).

- [ ] **Step 8: Commit**

```bash
git add src/bridge/adapter.ts src/bridge/httpAdapter.ts src/bridge/mockAdapter.ts src/bridge/comfyAdapter.ts tests/animateStill.test.ts
git commit -m "feat(svd): animateStill + listSvdModels adapter methods (http real, mock honest, comfy unsupported)"
```

---

### Task 5: Store — `animateStill` thunk + `svdModels` state

**Files:**
- Modify: `src/state/store.ts`
- Test: `tests/store.test.ts` (append)

**Interfaces:**
- Consumes: adapter `animateStill` / `listSvdModels`; the active adapter; the gallery-add path used by `renderActiveMotionClip` (grep how a video RenderResult is persisted to the gallery — reuse it).
- Produces on `StudioState`:
  - `svdModels: SvdModelInfo[]`, `refreshSvdModels(): Promise<void>`.
  - `animateStill(galleryId: string, opts: { frames: number; fps: number; motion: number; seed: number; modelPath: string }): Promise<{ ok: boolean; error?: string }>` — resolves the still's dataUrl → base64, calls the adapter, and on success adds the clip to the gallery (manifest records `svdSource: galleryId`, `engine:'svd'`). Guards: no `modelPath` → `{ ok:false, error:'No SVD model' }`.

- [ ] **Step 1: Write the failing test (append to `tests/store.test.ts`)**

```ts
import { mockAdapter } from '../src/state/store';

describe('studio store — animateStill', () => {
  it('refreshSvdModels populates from the adapter', async () => {
    await useStudio.getState().refreshSvdModels();
    expect(Array.isArray(useStudio.getState().svdModels)).toBe(true);
  });

  it('animateStill errors clearly when no model path is given', async () => {
    const r = await useStudio.getState().animateStill('nope', { frames: 14, fps: 7, motion: 127, seed: 0, modelPath: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/model/i);
  });

  it('animateStill returns ok:false for an unknown gallery id', async () => {
    const r = await useStudio.getState().animateStill('does-not-exist', { frames: 14, fps: 7, motion: 127, seed: 0, modelPath: '/m/svd' });
    expect(r.ok).toBe(false);
  });
});
```

(This test only exercises the guards — the mock adapter's honest placeholder + gallery-add can be smoke-checked in the browser. `mockAdapter` is already exported from the store module per existing tests.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/store.test.ts -t animateStill`
Expected: FAIL — `refreshSvdModels`/`animateStill` not defined.

- [ ] **Step 3: Implement in `src/state/store.ts`**

Add imports: `import type { SvdModelInfo, AnimateStillOptions } from '../bridge/adapter';` (adjust to the existing adapter import line).

Add to `StudioState`:

```ts
  svdModels: SvdModelInfo[];
  refreshSvdModels(): Promise<void>;
  animateStill(galleryId: string, opts: Omit<AnimateStillOptions, 'jobId'>): Promise<{ ok: boolean; error?: string }>;
```

Add `svdModels: []` to the initial store object.

Add the actions (place near `renderActiveMotionClip`; reuse the exact gallery-add call that path uses for a video result — shown here as `addGalleryItemFromResult`, replace with the real helper found in that function):

```ts
    refreshSvdModels: async () => {
      try {
        const models = await get().adapter().listSvdModels();
        set({ svdModels: models });
      } catch {
        set({ svdModels: [] });
      }
    },
    animateStill: async (galleryId, opts) => {
      if (!opts.modelPath) return { ok: false, error: 'No SVD model — put a Stable Video Diffusion model in your models folder.' };
      const item = get().gallery.find((g) => g.id === galleryId);
      if (!item) return { ok: false, error: 'That render is no longer in the gallery.' };
      const comma = item.dataUrl.indexOf(',');
      const imageBase64 = comma >= 0 ? item.dataUrl.slice(comma + 1) : item.dataUrl;
      try {
        const result = await get().adapter().animateStill(imageBase64, { ...opts, jobId: crypto.randomUUID() });
        // Reuse the same gallery-add path renderActiveMotionClip uses for a video result.
        await get().addRenderToGallery(result, {
          prompt: item.manifest?.prompt ?? '',
          svdSource: galleryId,
          engine: 'svd',
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
```

> Implementer note: `get().adapter()` and `addRenderToGallery(...)` are placeholders for whatever `renderActiveMotionClip` actually uses to (a) get the active adapter and (b) persist a video `RenderResult` into the gallery with a manifest. Grep `renderActiveMotionClip` in store.ts and mirror its exact adapter accessor + gallery-persist call so the SVD clip lands identically (IndexedDB + `gallery` state) — do NOT invent a new persistence path.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/store.test.ts -t animateStill && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts tests/store.test.ts
git commit -m "feat(svd): store animateStill thunk + svdModels state"
```

---

### Task 6: Gallery drawer "Animate" panel

**Files:**
- Modify: `src/components/gallery/Gallery.tsx` (the `Drawer` component — add an Animate action + inline panel)
- Modify: `src/styles/*` (reuse existing publish/drawer styles; add minimal `.svd-*` rules if needed)

**Interfaces:**
- Consumes: store `svdModels`, `refreshSvdModels`, `animateStill`; `Icon`.

- [ ] **Step 1: Add the Animate panel to the drawer**

In `src/components/gallery/Gallery.tsx`, inside `Drawer`, add near the other `useStudio` selectors:

```tsx
  const svdModels = useStudio((s) => s.svdModels);
  const refreshSvdModels = useStudio((s) => s.refreshSvdModels);
  const animateStill = useStudio((s) => s.animateStill);
  const [svdState, setSvdState] = useState<{ k: 'idle' } | { k: 'busy'; detail: string } | { k: 'err'; msg: string } | { k: 'done' }>({ k: 'idle' });
  const [motion, setMotion] = useState(127);
  const [svdFrames, setSvdFrames] = useState(14);
  useEffect(() => { void refreshSvdModels(); }, [refreshSvdModels]);
```

Only offer Animate for image items (not existing videos): guard `!item.mimeType?.startsWith('video/')`. Add the action button beside Share/Publish:

```tsx
            {!item.mimeType?.startsWith('video/') ? (
              <button className="btn" type="button" disabled={svdState.k === 'busy'} onClick={() => setSvdState((s) => (s.k === 'idle' || s.k === 'done' ? { k: 'idle' } : s)) /* toggle panel below */}>
                {Icon.play({ size: 14 })} Animate
              </button>
            ) : null}
```

And render the panel (below the actions), with the honest states:

```tsx
          {!item.mimeType?.startsWith('video/') ? (
            <div className="svd-panel">
              {svdModels.length === 0 ? (
                <p className="publish-note">{Icon.warning({ size: 13 })} No Stable Video Diffusion model found. Put an SVD model in your models folder, then reopen this.</p>
              ) : (
                <>
                  <p className="publish-note">Animate this still into a short coherent clip (SVD). On an 8GB GPU this can take a few minutes.</p>
                  <label className="svd-row">Motion <input type="range" min={1} max={255} value={motion} onChange={(e) => setMotion(Number(e.target.value))} /> {motion}</label>
                  <label className="svd-row">Frames <input type="number" min={8} max={25} value={svdFrames} onChange={(e) => setSvdFrames(Number(e.target.value))} /></label>
                  <button className="btn primary" type="button" disabled={svdState.k === 'busy'} onClick={async () => {
                    setSvdState({ k: 'busy', detail: 'Starting…' });
                    const r = await animateStill(item.id, { frames: svdFrames, fps: 7, motion, seed: 0, modelPath: svdModels[0].path });
                    setSvdState(r.ok ? { k: 'done' } : { k: 'err', msg: r.error ?? 'Animate failed' });
                  }}>{Icon.play({ size: 14 })} {svdState.k === 'busy' ? 'Animating…' : 'Animate'}</button>
                  {svdState.k === 'done' ? <span className="publish-ok">{Icon.ok({ size: 13 })} Clip added to the gallery.</span> : null}
                  {svdState.k === 'err' ? <span className="publish-result error">{Icon.error({ size: 13 })} {svdState.msg}</span> : null}
                </>
              )}
            </div>
          ) : null}
```

(Wire live progress by passing an `onProgress` through `animateStill` if desired; Phase 1 can show the busy state only. Simplify the toggle: it is fine to always render the panel for image items rather than gating on a button — remove the separate "Animate" action button if the panel is always shown.)

- [ ] **Step 2: Typecheck + full unit suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — no type errors; all suites green.

- [ ] **Step 3: Browser smoke (best-effort)**

Start the dev server; open a gallery item's drawer. With the built-in (mock) backend + no SVD model, confirm the honest "No SVD model found" note (or, if `svd-models` returns empty on mock, that state). If the Chrome bridge is unavailable in this environment, note it and rely on the unit suite. Capture a screenshot if possible.

- [ ] **Step 4: Commit**

```bash
git add src/components/gallery/Gallery.tsx src/styles
git commit -m "feat(svd): Gallery drawer Animate panel (honest no-model + busy/error states)"
```

---

### Task 7: Version bump + verify + PR

**Files:** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`

- [ ] **Step 1: Bump to 0.27.0** (all four; Read `Cargo.lock`'s `lumendeck` block then Edit).

- [ ] **Step 2: Verify**

Run: `npx vitest run tests/versionSync.test.ts && npm run typecheck && npx vitest run && npm run build && cd bridge && python -m pytest test_svd.py -q && cd ..`
Expected: versionSync PASS (all four == `0.27.0` == `APP_VERSION`); full JS suite green; typecheck clean; build succeeds; SVD python tests pass.

- [ ] **Step 3: Sidecar guard check**

`_animate_svd` imports `StableVideoDiffusionPipeline` from the already-bundled `diffusers` and PIL/torch from the managed runtime — no NEW top-level imports enter the frozen sidecar. Confirm `bridge/build_sidecar.py`'s exclude list is unchanged and nothing new needs excluding (the managed cp314 runtime supplies torch/diffusers at runtime). No sidecar rebuild required for tests.

- [ ] **Step 4: Commit + push + PR**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump to v0.27.0 (temporal coherence phase 1 — SVD animate)"
git push -u origin feature/temporal-coherence-p1
gh pr create --title "Temporal Coherence — Phase 1: SVD Animate this render (v0.27.0)" --body "$(cat <<'EOF'
Image-to-video: turn any gallery still into a short coherent H.264 clip via Stable Video Diffusion.

- Bridge `_animate_svd` (inside _WORKER_SOURCE): StableVideoDiffusionPipeline on a LOCAL model,
  CPU-offload + VAE slicing + small decode chunk for 8GB, output via the existing H.264 encoder.
  Loud on OOM / missing model / diffusers-absent — never a silent/procedural SVD clip.
- Local-folder model discovery (model_index class or svd*.safetensors); /svd-models + /animate-svd
  endpoints; conservative honest defaults (14 frames).
- animateStill + listSvdModels adapter methods (http real, mock explicitly-labeled, comfy unsupported);
  store thunk lands the clip in the gallery (svdSource lineage); Gallery-drawer Animate panel.
- Phase 1 of the temporal-coherence sub-project. AnimateDiff text→video already existed; this adds the
  missing image→video. Deferred: SVD-XT/hi-res, camera controls, in-app gated download, AnimateDiff
  mp4-hardening, keyframe smoothing.

Verification: pure helpers (target-size / clamp / detection), the TS adapter+store, and the mock path
are unit-tested; worker-source parity test guards the two-copy sync. The actual SVD generation can't run
in CI/this env (no model, no GPU) — it's a manual e2e gated on a local SVD model.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do NOT cut a public MSI release until the user explicitly says "release".

---

## Notes for the executor

- **Two-copy sync is the #1 risk.** `_animate_svd` + `_svd_target_size` + `_clamp_svd` live INSIDE `_WORKER_SOURCE`; the parity test (Task 2 Step 4) execs the source and checks they exist + clamp identically to the module copies. If you change one clamp, change both.
- Confirm the real names before wiring: `discover_model_dir` (server.py:643 uses it), the `HttpAdapter`/`MockAdapter` ctor + fetch handle, and `renderActiveMotionClip`'s adapter-accessor + gallery-persist call. Mirror them exactly — the plan's `get().adapter()` / `addRenderToGallery` are placeholders for those real symbols.
- SVD generation is unverifiable here; everything else is unit-tested. Keep every failure path loud (no silent/procedural SVD), matching the render-honesty ethos.
- `btoa` in the mock adapter is fine (browser + vitest jsdom). `crypto.randomUUID()` is available in WebView2 + vitest.
