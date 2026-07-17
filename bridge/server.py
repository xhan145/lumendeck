"""Pure-stdlib LumenDeck bridge (no third-party deps) for PyInstaller bundling.

Exposes the same contract as the old FastAPI bridge:
  GET  /health   -> {"status":"ok","adapter":"procedural","diffusers":bool}
  GET  /models   -> ModelAsset[]
  GET  /diffusers/status -> Diffusers dependency/model status
  POST /diffusers/install -> install managed Diffusers runtime + model
  POST /diffusers/download -> download/load the configured Diffusers model
  GET  /controlnet/capabilities?model=<shelf id> -> {"family": "...", "types": [...]}
  POST /controlnet/preprocess -> {"map_base64": "..."} (on-demand control-map preview)
  POST /generate -> {"image_base64": "...", "seed": int}
  GET  /cloud/providers -> hosted providers + curated models + hasKey
  POST /cloud/keys -> persist a provider API key bridge-side (blank key clears)
  POST /cloud/generate -> run one RenderJob on a hosted provider (loud errors)

`build_response` is a pure function so it can be unit-tested without binding a socket.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from renderer import RenderRequest, render_gif_base64, render_png_base64, render_sequence_gif_base64
from scanner import (
    configured_model_dir,
    discover_model_dir,
    get_shelf,
    model_dir_status,
    set_configured_model_dir,
)

try:
    import civitai
    _HAS_CIVITAI = True
except Exception:
    _HAS_CIVITAI = False

try:
    import cloud as cloud_providers
    _HAS_CLOUD = True
except Exception:
    _HAS_CLOUD = False

# Built web app (from `npm run build`). When present, the bridge serves the whole
# UI on the same origin as the API, so the browser never makes a cross-origin call.
DIST_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dist"))
API_PREFIXES = ("/health", "/models", "/svd-models", "/model-folder", "/generate", "/render-motion", "/animate-svd", "/evolve-step", "/diffusers", "/progress", "/civitai", "/controlnet", "/cloud")


def _civitai_dest(file_name: str, asset_type: str) -> str:
    """Resolve where a downloaded Civitai file should land in the model folder.

    LoRAs go under loras/ so the scanner tags them correctly; checkpoints at root.
    Falls back to an app-local models folder (persisted) when none is configured."""
    root = configured_model_dir()
    if not root or not os.path.isdir(root):
        root = os.path.join(
            os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LumenDeck", "models",
        )
        os.makedirs(root, exist_ok=True)
        try:
            set_configured_model_dir(root)
        except Exception:
            os.environ["LUMENDECK_MODEL_DIR"] = root
    safe = os.path.basename(file_name) or "model.safetensors"
    if asset_type.lower() == "lora":
        return os.path.join(root, "loras", safe)
    return os.path.join(root, safe)

# ---- Render progress (file-based; the diffusers worker is a separate process) ----
_JOB_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def _progress_path(job_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"lumendeck-progress-{job_id}.json")


def _write_progress(job_id: str, data: dict) -> None:
    try:
        with open(_progress_path(job_id), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
    except OSError:
        pass


def _read_progress(job_id: str) -> dict:
    try:
        with open(_progress_path(job_id), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"phase": "unknown"}


def _prune_progress_files(max_age_s: int = 3600) -> None:
    """Drop stale progress + parked cloud-result files so temp doesn't accumulate them."""
    try:
        now = time.time()
        for name in os.listdir(tempfile.gettempdir()):
            if not name.startswith(("lumendeck-progress-", "lumendeck-cloudresult-")):
                continue
            path = os.path.join(tempfile.gettempdir(), name)
            try:
                if now - os.path.getmtime(path) > max_age_s:
                    os.remove(path)
            except OSError:
                pass
    except OSError:
        pass

# ---- Cloud route protection ----------------------------------------------
# The bridge answers every route with `Access-Control-Allow-Origin: *`, which
# is fine for local render plumbing but NOT for routes that front paid API
# keys: a hostile website could POST /cloud/keys or burn credits via
# /cloud/generate from the user's browser. /cloud/* therefore only accepts
# requests whose Origin is the app itself (Tauri webview, the bridge's own
# static server, or the Vite dev server). Non-browser clients send no Origin.
_TRUSTED_ORIGINS = frozenset({
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:5178",
    "http://127.0.0.1:5178",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
})

# API keys are printable-ASCII tokens. Reject anything else at save time so a
# control character can never reach urllib headers (whose exceptions would
# echo the full key back into an error response).
_KEY_SHAPE = re.compile(r"^[\x21-\x7e]{1,512}$")


def _cloud_result_path(job_id: str) -> str:
    """Cloud renders can outlive the webview's fetch timeout (long video tasks);
    the result is also parked here so the adapter can recover it by job id."""
    return os.path.join(tempfile.gettempdir(), f"lumendeck-cloudresult-{job_id}.json")


# ---- Bridge-side settings (cloud API keys live here, NEVER in the browser) ----
def _settings_path() -> str:
    override = os.environ.get("LUMENDECK_SETTINGS_PATH")
    if override:
        return override
    root = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LumenDeck")
    return os.path.join(root, "settings.json")


def _load_settings(strict: bool = False) -> dict:
    """Read settings.json. A MISSING file is a normal empty state; an unreadable
    or corrupt file only returns {} on best-effort reads — strict callers that
    intend to WRITE the file back must get the error instead, or a read-modify-
    write would silently replace the whole file (wiping other providers' keys)."""
    path = _settings_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("settings.json root is not an object")
        return data
    except Exception:
        if strict:
            raise
        return {}


def _save_settings(settings: dict) -> None:
    path = _settings_path()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    # Atomic replace: a crash mid-write must never destroy the existing file.
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, indent=2)
    os.replace(tmp, path)


try:
    import diffusers_backend
    _HAS_DIFFUSERS_MODULE = True
except Exception:
    _HAS_DIFFUSERS_MODULE = False

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

# ControlNet type superset (SD1.5 supports the full set). Fallback literal only:
# the authoritative table is diffusers_backend.CONTROLNET_MODELS — this keeps
# /controlnet/capabilities answering harmlessly when that module is missing.
_SD15_CONTROL_TYPES = ("canny", "depth", "pose", "scribble", "lineart", "softedge", "tile")


def _all_control_types() -> list:
    if _HAS_DIFFUSERS_MODULE:
        table = getattr(diffusers_backend, "CONTROLNET_MODELS", None)
        if table:
            return list(table.get("SD1.5", {}))
    return list(_SD15_CONTROL_TYPES)


def _diffusers_available() -> bool:
    return _HAS_DIFFUSERS_MODULE and diffusers_backend.is_available()


# Probing diffusers availability spawns worker subprocesses (seconds). /health and
# /models must answer instantly (the app pings with a 1.5s timeout), so they read a
# cache refreshed by a background thread; /generate keeps the authoritative check.
_STATUS_CACHE: dict = {"ts": 0.0, "available": False, "status": None, "busy": False}


def _refresh_diffusers_cache_async() -> None:
    if _STATUS_CACHE["busy"]:
        return
    _STATUS_CACHE["busy"] = True

    def work() -> None:
        try:
            available = _diffusers_available()
            status = _diffusers_status()
            _STATUS_CACHE.update(available=available, status=status, ts=time.time())
        except Exception:
            _STATUS_CACHE["ts"] = time.time()
        finally:
            _STATUS_CACHE["busy"] = False

    threading.Thread(target=work, daemon=True).start()


def _cached_diffusers() -> tuple[bool, dict]:
    if time.time() - _STATUS_CACHE["ts"] > 30:
        _refresh_diffusers_cache_async()
    status = _STATUS_CACHE["status"]
    if status is None:
        status = {
            "modelId": "stabilityai/sd-turbo",
            "dependenciesReady": False,
            "loaded": False,
            "modelCached": None,
            "message": "Checking Diffusers availability…",
        }
    return bool(_STATUS_CACHE["available"]), status


def _set_diffusers_cache(status: dict) -> None:
    _STATUS_CACHE.update(
        available=bool(status.get("dependenciesReady")) and status.get("modelCached") is not False,
        status=status,
        ts=time.time(),
        busy=False,
    )


def _diffusers_status() -> dict:
    if not _HAS_DIFFUSERS_MODULE:
        return {
            "modelId": "stabilityai/sd-turbo",
            "dependenciesReady": False,
            "loaded": False,
            "modelCached": None,
            "device": "unknown",
            "cuda": False,
            "cacheDir": "",
            "installCommand": "python -m pip install torch diffusers transformers accelerate",
            "message": "Diffusers bridge module is not available in this build.",
            "dependencies": {"ready": False},
        }
    return diffusers_backend.model_status()


def _diffusers_shelf_entry() -> dict:
    """The real Diffusers model, surfaced as a selectable checkpoint on the shelf.

    Marked installed only when it can actually render (deps present AND weights
    cached), so the app auto-selects it only when real output will succeed.
    """
    _available, status = _cached_diffusers()
    ready = bool(status.get("dependenciesReady"))
    cached = status.get("modelCached")
    # Usable when deps are present and the weights are not known-missing. If cache
    # state is unknown (None), stay optimistic — the first render downloads on demand.
    installed = ready and cached is not False
    model_id = status.get("modelId", "stabilityai/sd-turbo")
    return {
        "id": "diffusers-real",
        "assetType": "checkpoint",
        "name": f"{model_id.split('/')[-1]} (real diffusion)",
        "family": "SDXL",
        "path": model_id,
        "hash": "diffusers",
        "sizeMB": 0,
        "tags": ["real", "diffusers", "turbo"],
        "compatibility": status.get("message", "Real Diffusers text-to-image model."),
        "license": f"{model_id} — see model card",
        "installed": installed,
    }


HUB_MODELS = {
    # shelf id -> Hugging Face model id (None = the configured default model)
    "diffusers-real": None,
    "diffusers-sdxl": "stabilityai/sdxl-turbo",
}


def _hub_cached(hub_id: str) -> bool:
    """Filesystem check for HF-cache presence (works in the frozen sidecar too)."""
    cache_root = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    folder = "models--" + hub_id.replace("/", "--")
    return any(
        os.path.isdir(os.path.join(cache_root, sub, folder))
        for sub in ("hub", "")
    )


def _sdxl_shelf_entry() -> dict:
    _available, status = _cached_diffusers()
    ready = bool(status.get("dependenciesReady"))
    hub_id = "stabilityai/sdxl-turbo"
    installed = ready and _hub_cached(hub_id)
    return {
        "id": "diffusers-sdxl",
        "assetType": "checkpoint",
        "name": "sdxl-turbo (real diffusion)",
        "family": "SDXL",
        "path": hub_id,
        "hash": "diffusers",
        "sizeMB": 6940,
        "tags": ["real", "diffusers", "turbo", "sdxl"],
        "compatibility": "Real SDXL-Turbo. First use downloads ~7 GB to the Hugging Face cache."
        + ("" if installed else " Not downloaded yet."),
        "license": f"{hub_id} — see model card",
        "installed": installed,
    }


def _shelf_with_real() -> list:
    """Local scan (or demo) plus the real Diffusers models; usable real model first."""
    shelf = list(get_shelf())
    entry = _diffusers_shelf_entry()
    shelf.append(_sdxl_shelf_entry())
    if entry["installed"]:
        return [entry, *shelf]
    shelf.append(entry)
    return shelf


def _asset_abs_path(asset: dict, model_root: str | None) -> str | None:
    """Absolute on-disk path for a shelf asset, or None when there is no real file."""
    rel = str(asset.get("path", ""))
    if os.path.isabs(rel) and os.path.isfile(rel):
        return os.path.normpath(rel)
    if model_root:
        candidate = os.path.normpath(os.path.join(model_root, rel))
        if os.path.isfile(candidate):
            return candidate
    return None


def _model_ref_for(model_id: str, shelf: list, model_root: str | None) -> dict:
    """Resolve a shelf model id to the worker's modelRef (read-only, pure).

    Shared by /generate (via _resolve_render_targets) and /controlnet/capabilities
    so both answer for exactly the same model. Unknown/demo ids resolve to the
    default hub model."""
    if model_id in HUB_MODELS:
        hub = HUB_MODELS[model_id]
        return {"kind": "hub", "id": hub} if hub else {"kind": "hub"}
    assets = {str(a.get("id")): a for a in shelf}
    asset = assets.get(model_id)
    path = _asset_abs_path(asset, model_root) if asset and asset.get("assetType") == "checkpoint" else None
    if path:
        return {"kind": "file", "path": path, "family": asset.get("family", "")}
    return {"kind": "hub"}  # default model


def _resolve_render_targets(job: dict, shelf: list, model_root: str | None) -> dict:
    """Annotate a render job with modelRef/loraFiles for the diffusers worker.

    Pure given its inputs (shelf list + scan root), so it is unit-testable.
    Unknown/demo assets resolve to the default hub model / are skipped.
    """
    assets = {str(a.get("id")): a for a in shelf}
    job["modelRef"] = _model_ref_for(str(job.get("modelId") or ""), shelf, model_root)

    lora_files = []
    for lora in job.get("loras") or []:
        asset = assets.get(str(lora.get("id")))
        if not asset or asset.get("assetType") != "lora":
            continue
        path = _asset_abs_path(asset, model_root)
        if not path:
            print(f"[models] skipping LoRA without a real file: {lora.get('id')}", flush=True)
            continue
        lora_files.append({"path": path, "weight": float(lora.get("weight", 1.0))})
    job["loraFiles"] = lora_files
    return job


def _procedural(job: dict) -> dict:
    seed = int(job.get("seed", 0))
    if seed < 0:
        seed = abs(hash(job.get("prompt", ""))) % 0xFFFFFFFF
    req = RenderRequest(
        prompt=str(job.get("prompt", "")),
        seed=seed,
        width=int(job.get("width", 512)),
        height=int(job.get("height", 512)),
        steps=int(job.get("steps", 28)),
        cfg=float(job.get("cfg", 7.0)),
        loras=len(job.get("loras", []) or []),
        frame_count=int(job.get("frameCount", 1)),
        fps=int(job.get("fps", 8)),
        motion_strength=float(job.get("motionStrength", 0.7)),
        camera_motion=str(job.get("cameraMotion", "orbit")),
        loop=bool(job.get("loop", True)),
    )
    if str(job.get("output", "image")) == "video":
        return {
            "video_base64": render_gif_base64(req),
            "seed": seed,
            "mediaType": "video",
            "mimeType": "image/gif",
            "extension": "gif",
        }
    return {"image_base64": render_png_base64(req), "seed": seed}


def _procedural_motion(jobs: list, fps: int, loop: bool = True) -> dict:
    """Render a motion clip procedurally: one still per job, stitched into a GIF.

    The loud fallback for /render-motion when real diffusion isn't available or a
    render raises. Each job is a distinct keyframe (e.g. a cfg sweep), so the frames
    visibly differ. Returns the same video shape as the real render.
    """
    reqs = []
    seed = 0
    for index, job in enumerate(jobs):
        job_seed = int(job.get("seed", 0))
        if job_seed < 0:
            job_seed = abs(hash(job.get("prompt", ""))) % 0xFFFFFFFF
        if index == 0:
            seed = job_seed
        reqs.append(
            RenderRequest(
                prompt=str(job.get("prompt", "")),
                seed=job_seed,
                width=int(job.get("width", 512)),
                height=int(job.get("height", 512)),
                steps=int(job.get("steps", 28)),
                cfg=float(job.get("cfg", 7.0)),
                camera_motion=str(job.get("cameraMotion", "orbit")),
                loop=loop,
            )
        )
    return {
        "video_base64": render_sequence_gif_base64(reqs, fps),
        "seed": seed,
        "mediaType": "video",
        "mimeType": "image/gif",
        "extension": "gif",
        "frameCount": len(reqs),
        "fps": max(1, min(30, fps)),
    }


def build_response(method: str, path: str, body: bytes, origin: str = ""):
    """Return (status_code, headers_dict, body_bytes) for a request. Pure & testable.

    `origin` is the request's Origin header (empty for same-origin GETs and
    non-browser clients); /cloud/* routes reject untrusted browser origins."""
    headers = dict(CORS)
    if method == "OPTIONS":
        return 204, headers, b""

    if path.startswith("/cloud") and origin and origin not in _TRUSTED_ORIGINS:
        headers["Content-Type"] = "application/json"
        return 403, headers, json.dumps({
            "error": "cross-origin access to /cloud is not allowed",
        }).encode()

    if method == "GET" and path == "/health":
        headers["Content-Type"] = "application/json"
        available, status = _cached_diffusers()
        payload = {"status": "ok", "adapter": "procedural", "diffusers": available, "model": status}
        return 200, headers, json.dumps(payload).encode()

    if method == "GET" and path == "/models":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(_shelf_with_real()).encode()

    if method == "GET" and path == "/svd-models":
        headers["Content-Type"] = "application/json"
        try:
            models = diffusers_backend.find_svd_models(discover_model_dir())
            return 200, headers, json.dumps({"models": models}).encode()
        except Exception as exc:
            return 200, headers, json.dumps({"models": [], "error": str(exc)}).encode()

    if method == "GET" and path == "/model-folder":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(model_dir_status()).encode()

    if method == "GET" and path.startswith("/civitai/search"):
        headers["Content-Type"] = "application/json"
        if not _HAS_CIVITAI:
            return 503, headers, json.dumps({"error": "Civitai module unavailable in this build."}).encode()
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
        query = qs.get("query", [""])[0]
        types = qs.get("type", ["Checkpoint"])[0]
        token = qs.get("token", [""])[0] or os.environ.get("CIVITAI_TOKEN", "")
        try:
            items = civitai.search(query, types=types, token=token)
            return 200, headers, json.dumps({"items": items}).encode()
        except Exception as exc:
            return 502, headers, json.dumps({"error": f"Civitai search failed: {exc}"}).encode()

    if method == "POST" and path == "/civitai/download":
        headers["Content-Type"] = "application/json"
        if not _HAS_CIVITAI:
            return 503, headers, json.dumps({"error": "Civitai module unavailable in this build."}).encode()
        try:
            req = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        url = str(req.get("downloadUrl", ""))
        if not url:
            return 400, headers, json.dumps({"error": "downloadUrl is required"}).encode()
        asset_type = str(req.get("assetType", "checkpoint"))
        token = str(req.get("token", "")) or os.environ.get("CIVITAI_TOKEN", "")
        job_id = str(req.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        dest = _civitai_dest(str(req.get("fileName", "")), asset_type)

        def _report(received: int, total: int) -> None:
            if track:
                _write_progress(job_id, {"phase": "downloading", "received": received, "total": total})

        try:
            result = civitai.download(url, dest, token=token, progress=_report)
            if track:
                _write_progress(job_id, {"phase": "done"})
            return 200, headers, json.dumps(result).encode()
        except Exception as exc:
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 502, headers, json.dumps({"error": f"Download failed: {exc}"}).encode()

    if method == "GET" and path.startswith("/progress/"):
        headers["Content-Type"] = "application/json"
        job_id = path[len("/progress/"):]
        if not _JOB_ID.match(job_id):
            return 200, headers, json.dumps({"phase": "unknown"}).encode()
        return 200, headers, json.dumps(_read_progress(job_id)).encode()

    if method == "GET" and path == "/diffusers/status":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(_diffusers_status()).encode()

    if method == "POST" and path == "/diffusers/download":
        headers["Content-Type"] = "application/json"
        if not _HAS_DIFFUSERS_MODULE:
            return 503, headers, json.dumps({"error": "diffusers backend module is not available in this build"}).encode()
        try:
            status = diffusers_backend.download_model()
            _set_diffusers_cache(status)
            return 200, headers, json.dumps(status).encode()
        except Exception as exc:
            return 503, headers, json.dumps({"error": str(exc), "status": _diffusers_status()}).encode()

    if method == "POST" and path == "/diffusers/install":
        headers["Content-Type"] = "application/json"
        if not _HAS_DIFFUSERS_MODULE:
            return 503, headers, json.dumps({"error": "diffusers backend module is not available in this build"}).encode()
        try:
            status = diffusers_backend.install_runtime()
            _set_diffusers_cache(status)
            return 200, headers, json.dumps(status).encode()
        except Exception as exc:
            return 503, headers, json.dumps({"error": str(exc), "status": _diffusers_status()}).encode()

    if method == "GET" and path.startswith("/controlnet/capabilities"):
        headers["Content-Type"] = "application/json"
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
        model_query = qs.get("model", [""])[0]
        if not _HAS_DIFFUSERS_MODULE:
            # Harmless static answer (never a 500) so the UI can still draw the rack.
            payload = {"family": "SD1.5", "types": list(_SD15_CONTROL_TYPES), "available": False}
            return 200, headers, json.dumps(payload).encode()
        try:
            caps = diffusers_backend.capabilities(model_query or None, _shelf_with_real(), discover_model_dir())
            return 200, headers, json.dumps(caps).encode()
        except Exception as exc:
            payload = {"family": "SD1.5", "types": list(_SD15_CONTROL_TYPES), "available": False, "error": str(exc)}
            return 200, headers, json.dumps(payload).encode()

    if method == "POST" and path == "/controlnet/preprocess":
        headers["Content-Type"] = "application/json"
        if not _HAS_DIFFUSERS_MODULE:
            return 503, headers, json.dumps({"error": "diffusers backend module is not available in this build"}).encode()
        try:
            req = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        ctrl_type = str(req.get("type", "") or "").lower()
        if ctrl_type not in _all_control_types():
            return 400, headers, json.dumps({
                "error": f"unknown control type: {ctrl_type or '(missing)'}. Expected one of: {', '.join(_all_control_types())}",
            }).encode()
        if not req.get("image"):
            return 400, headers, json.dumps({"error": "image (base64 or data URL) is required"}).encode()
        try:
            result = diffusers_backend.preprocess(req)
            return 200, headers, json.dumps(result).encode()
        except Exception as exc:
            return 503, headers, json.dumps({"error": f"preprocess failed: {exc}"}).encode()

    if method == "POST" and path == "/model-folder":
        headers["Content-Type"] = "application/json"
        try:
            data = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        try:
            status = set_configured_model_dir(str(data.get("path", "")))
            return 200, headers, json.dumps(status).encode()
        except Exception as exc:
            return 400, headers, json.dumps({"error": str(exc), "status": model_dir_status()}).encode()

    if method == "GET" and path == "/cloud/providers":
        headers["Content-Type"] = "application/json"
        if not _HAS_CLOUD:
            return 503, headers, json.dumps({"error": "cloud module unavailable in this build"}).encode()
        keys = _load_settings().get("cloudKeys") or {}
        return 200, headers, json.dumps({"providers": cloud_providers.provider_listing(keys)}).encode()

    if method == "POST" and path == "/cloud/keys":
        headers["Content-Type"] = "application/json"
        if not _HAS_CLOUD:
            return 503, headers, json.dumps({"error": "cloud module unavailable in this build"}).encode()
        try:
            req = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        provider_id = str(req.get("provider", ""))
        if provider_id not in cloud_providers.PROVIDERS:
            return 400, headers, json.dumps({"error": f"unknown provider: {provider_id or '(missing)'}"}).encode()
        key = str(req.get("key", "")).strip()
        if key and not _KEY_SHAPE.match(key):
            return 400, headers, json.dumps({
                "error": "key contains invalid characters (expected a printable ASCII token)",
            }).encode()
        try:
            settings = _load_settings(strict=True)
        except Exception as exc:
            return 503, headers, json.dumps({
                "error": f"settings.json is unreadable ({exc}); refusing to overwrite it. Fix or delete the file.",
            }).encode()
        cloud_keys = settings.get("cloudKeys")
        if not isinstance(cloud_keys, dict):
            cloud_keys = {}
        if key:
            cloud_keys[provider_id] = key
        else:
            cloud_keys.pop(provider_id, None)  # blank key clears the entry
        settings["cloudKeys"] = cloud_keys
        try:
            _save_settings(settings)
        except OSError as exc:
            return 503, headers, json.dumps({"error": f"could not persist settings: {exc}"}).encode()
        return 200, headers, json.dumps({"ok": True, "hasKey": bool(key)}).encode()

    if method == "POST" and path == "/cloud/generate":
        headers["Content-Type"] = "application/json"
        if not _HAS_CLOUD:
            return 503, headers, json.dumps({"error": "cloud module unavailable in this build"}).encode()
        try:
            job = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        provider_id = str(job.get("provider", ""))
        provider = cloud_providers.PROVIDERS.get(provider_id)
        if provider is None:
            return 400, headers, json.dumps({"error": f"unknown provider: {provider_id or '(missing)'}"}).encode()
        model = str(job.get("model", ""))
        if not model:
            return 400, headers, json.dumps({"error": "model is required"}).encode()
        # Only curated model ids may reach the provider layer — the model string
        # is interpolated into provider URLs, so free-form values are rejected.
        if not any(m["id"] == model for m in provider.models()):
            return 400, headers, json.dumps({
                "error": f"unknown model for {provider.label}: {model}",
            }).encode()
        stored = _load_settings().get("cloudKeys")
        stored = stored if isinstance(stored, dict) else {}
        key = str(stored.get(provider_id, "")).strip()
        if not key:
            return 400, headers, json.dumps({
                "error": f"no API key saved for {provider.label}. Save one under Backend -> Cloud.",
            }).encode()
        if not _KEY_SHAPE.match(key):
            return 400, headers, json.dumps({
                "error": f"the saved key for {provider.label} contains invalid characters — re-save it.",
            }).encode()
        job_id = str(job.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        if track:
            _prune_progress_files()
            _write_progress(job_id, {"phase": "loading"})

        def _report(update: dict) -> None:
            # Map cloud phases onto the progress shape the adapter already polls
            # ({phase, step, steps}); queued -> loading, running -> rendering.
            if not track:
                return
            phase = str(update.get("phase", "running"))
            try:
                fraction = max(0.0, min(1.0, float(update.get("progress") or 0.0)))
            except (TypeError, ValueError):
                fraction = 0.0
            if phase == "queued":
                _write_progress(job_id, {"phase": "loading"})
            else:
                _write_progress(job_id, {"phase": "rendering", "step": int(fraction * 100), "steps": 100})

        try:
            result = provider.generate(job, model, key, _report)
            payload = json.dumps(result).encode()
            if track:
                # Park the result so the adapter can recover it via
                # GET /cloud/result/<jobId> if this response outlived the
                # webview's fetch timeout (long video tasks).
                try:
                    with open(_cloud_result_path(job_id), "wb") as fh:
                        fh.write(payload)
                except OSError:
                    pass
                _write_progress(job_id, {"phase": "done"})
            return 200, headers, payload
        except cloud_providers.CloudError as exc:
            if track:
                _write_progress(job_id, {"phase": "error", "detail": str(exc)})
            return 502, headers, json.dumps({"error": str(exc)}).encode()
        except Exception as exc:
            if track:
                _write_progress(job_id, {"phase": "error", "detail": str(exc)})
            return 502, headers, json.dumps({"error": f"{provider_id}: {exc}"}).encode()

    if method == "GET" and path.startswith("/cloud/result/"):
        headers["Content-Type"] = "application/json"
        job_id = path[len("/cloud/result/"):]
        if not _JOB_ID.match(job_id):
            return 400, headers, json.dumps({"error": "invalid job id"}).encode()
        try:
            with open(_cloud_result_path(job_id), "rb") as fh:
                return 200, headers, fh.read()
        except OSError:
            return 404, headers, json.dumps({
                "error": "no result for this job (still running, failed, or expired)",
            }).encode()

    if method == "POST" and path == "/generate":
        headers["Content-Type"] = "application/json"
        try:
            job = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        mode = str(job.get("renderer", "auto"))
        job_id = str(job.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        if track:
            _prune_progress_files()
            job["progressPath"] = _progress_path(job_id)
            _write_progress(job_id, {"phase": "loading"})
        fallback_reason = None
        fallback_category = None
        if str(job.get("output", "image")) == "video":
            # Real video (AnimateDiff on the selected model) when the bridge can;
            # otherwise a procedural GIF, never a silent placeholder.
            if mode in ("diffusers", "auto") and _diffusers_available():
                try:
                    _resolve_render_targets(job, _shelf_with_real(), discover_model_dir())
                    result = diffusers_backend.generate(job)
                    if track:
                        _write_progress(job_id, {"phase": "done"})
                    return 200, headers, json.dumps(result).encode()
                except Exception as exc:
                    import traceback
                    print(f"[animatediff] video failed, falling back to procedural GIF: {exc}", flush=True)
                    traceback.print_exc()
                    fallback_reason = str(exc)
            result = _procedural(job)
            if fallback_reason:
                result["fallback"] = True
                result["fallbackReason"] = fallback_reason
            if track:
                _write_progress(job_id, {"phase": "done"})
            return 200, headers, json.dumps(result).encode()
        if mode in ("diffusers", "auto") and _diffusers_available():
            try:
                _resolve_render_targets(job, _shelf_with_real(), discover_model_dir())
                result = diffusers_backend.generate(job)
                if track:
                    _write_progress(job_id, {"phase": "done"})
                return 200, headers, json.dumps(result).encode()
            except Exception as exc:  # fall back to procedural on any inference error
                import traceback
                print(f"[diffusers] render failed, falling back to procedural: {exc}", flush=True)
                traceback.print_exc()
                fallback_reason = str(exc)
                # Forward the worker's precise error category (e.g. 'cuda_oom') so
                # the app's OOM safe-retry never depends on message-text matching.
                fallback_category = getattr(exc, "error_category", None)
                if mode == "diffusers":
                    if track:
                        _write_progress(job_id, {"phase": "error"})
                    payload = {"error": f"diffusers failed: {exc}"}
                    if fallback_category:
                        payload["errorCategory"] = fallback_category
                    return 503, headers, json.dumps(payload).encode()
        if mode == "diffusers" and not _diffusers_available():
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 503, headers, json.dumps({"error": "diffusers/torch not installed on the bridge"}).encode()
        if mode == "auto" and not _diffusers_available():
            fallback_reason = "Real diffusion isn't ready on the bridge (torch/model not installed)."
        result = _procedural(job)
        # Never a silent placeholder: tell the UI a real render was expected but fell back.
        if fallback_reason:
            result["fallback"] = True
            result["fallbackReason"] = fallback_reason
            if fallback_category:
                result["fallbackCategory"] = fallback_category
        if track:
            _write_progress(job_id, {"phase": "done"})
        return 200, headers, json.dumps(result).encode()

    if method == "POST" and path == "/render-motion":
        headers["Content-Type"] = "application/json"
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        jobs = payload.get("jobs")
        if not isinstance(jobs, list) or not jobs:
            return 400, headers, json.dumps({"error": "jobs must be a non-empty list"}).encode()
        if not all(isinstance(job, dict) for job in jobs):
            return 400, headers, json.dumps({"error": "every job must be an object"}).encode()
        # Clamp frame count server-side (spec: 1..120), independent of the UI clamp.
        jobs = jobs[:120]
        fps = int(payload.get("fps", 8))
        fmt = str(payload.get("format", "mp4"))
        loop = bool(jobs[0].get("loop", True))
        mode = str(payload.get("renderer", "auto"))
        job_id = str(payload.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        progress_path = None
        if track:
            _prune_progress_files()
            progress_path = _progress_path(job_id)
            _write_progress(job_id, {"phase": "loading"})
        fallback_reason = None
        # Real per-frame diffusion (model resident across frames) when the bridge can;
        # otherwise a procedural GIF, never a silent placeholder.
        if mode in ("diffusers", "auto") and _diffusers_available():
            try:
                shelf = _shelf_with_real()
                model_root = discover_model_dir()
                for job in jobs:
                    _resolve_render_targets(job, shelf, model_root)
                render_payload = {"jobs": jobs, "fps": fps, "format": fmt}
                if progress_path:
                    render_payload["progressPath"] = progress_path
                result = diffusers_backend.render_motion(render_payload)
                if track:
                    _write_progress(job_id, {"phase": "done"})
                return 200, headers, json.dumps(result).encode()
            except Exception as exc:
                import traceback
                print(f"[render-motion] render failed, falling back to procedural GIF: {exc}", flush=True)
                traceback.print_exc()
                fallback_reason = str(exc)
        if mode == "auto" and not _diffusers_available():
            fallback_reason = "Real diffusion isn't ready on the bridge (torch/model not installed)."
        result = _procedural_motion(jobs, fps, loop=loop)
        # Never a silent placeholder: tell the UI a real render was expected but fell back.
        result["fallback"] = True
        result["fallbackReason"] = fallback_reason or "Rendered a procedural motion clip."
        if track:
            _write_progress(job_id, {"phase": "done"})
        return 200, headers, json.dumps(result).encode()

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
        # Containment: only load an SVD model that is a real SVD under the models dir —
        # never an arbitrary client-supplied path (mirrors the /generate id->vetted-path model).
        model_path = str(payload.get("modelPath") or "")
        try:
            root = os.path.realpath(discover_model_dir())
            rp = os.path.realpath(model_path) if model_path else ""
        except Exception:
            rp, root = "", ""
        if not rp or not root or not (rp == root or rp.startswith(root + os.sep)) or not diffusers_backend.is_svd_model(rp):
            return 200, headers, json.dumps({"error": "SVD model path is not an allowed local model. Put a Stable Video Diffusion model in your models folder."}).encode()
        payload["modelPath"] = rp
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
            # SVD has NO honest procedural equivalent - surface the error, never a fake clip.
            return 200, headers, json.dumps({"error": str(exc)}).encode()

    if method == "POST" and path == "/evolve-step":
        headers["Content-Type"] = "application/json"
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        jobs = payload.get("jobs")
        if not isinstance(jobs, list) or not jobs:
            return 400, headers, json.dumps({"error": "jobs must be a non-empty list"}).encode()
        if not all(isinstance(job, dict) for job in jobs):
            return 400, headers, json.dumps({"error": "every job must be an object"}).encode()
        # Population clamp 2..8 (server): cap the candidate count regardless of the UI.
        jobs = jobs[:8]
        prompt = str(payload.get("prompt", ""))
        weights = payload.get("weights")
        if not isinstance(weights, dict):
            weights = {}
        job_id = str(payload.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        progress_path = None
        if track:
            _prune_progress_files()
            progress_path = _progress_path(job_id)
            _write_progress(job_id, {"phase": "loading"})
        # Auto-evolve REQUIRES real renders + scoring. There is NO procedural fallback
        # for scoring, so an unavailable runtime or any failure is a LOUD 503 (never a
        # silent placeholder / fake score).
        if not _diffusers_available():
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 503, headers, json.dumps({
                "error": "Auto-evolve needs the real Diffusers runtime (torch/model not installed on the bridge).",
            }).encode()
        try:
            shelf = _shelf_with_real()
            model_root = discover_model_dir()
            for job in jobs:
                _resolve_render_targets(job, shelf, model_root)
            evolve_payload = {"jobs": jobs, "prompt": prompt, "weights": weights}
            if progress_path:
                evolve_payload["progressPath"] = progress_path
            result = diffusers_backend.evolve_step(evolve_payload)
            if track:
                _write_progress(job_id, {"phase": "done"})
            return 200, headers, json.dumps(result).encode()
        except Exception as exc:
            import traceback
            print(f"[evolve-step] evolve failed: {exc}", flush=True)
            traceback.print_exc()
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 503, headers, json.dumps({"error": f"evolve failed: {exc}"}).encode()

    return 404, headers, json.dumps({"error": "not found"}).encode()


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, headers, body):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send(*build_response("OPTIONS", self.path, b""))

    def do_GET(self):  # noqa: N802
        status, headers, body = build_response("GET", self.path, b"", self.headers.get("Origin", ""))
        if status == 404 and self._serve_static():
            return
        self._send(status, headers, body)

    def _serve_static(self) -> bool:
        """Serve the built SPA from dist/. Returns True if it handled the request."""
        if not os.path.isdir(DIST_DIR):
            return False
        path = self.path.split("?", 1)[0]
        if any(path.startswith(p) for p in API_PREFIXES):
            return False
        rel = path.lstrip("/") or "index.html"
        target = os.path.abspath(os.path.join(DIST_DIR, rel))
        # Block path traversal; fall back to index.html for SPA client routes.
        if not target.startswith(DIST_DIR) or not os.path.isfile(target):
            target = os.path.join(DIST_DIR, "index.html")
            if not os.path.isfile(target):
                return False
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            return False
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        self._send(200, {"Content-Type": ctype}, data)
        return True

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        self._send(*build_response("POST", self.path, self.rfile.read(length), self.headers.get("Origin", "")))

    def log_message(self, *_args):  # silence default stderr logging
        pass


def _watch_parent_via_stdin() -> None:
    """Exit when the parent process closes our stdin pipe.

    Tauri spawns the sidecar with a piped stdin; when the desktop app exits (cleanly
    or by crash), that pipe closes and stdin hits EOF. This guarantees the sidecar
    dies with its parent even through PyInstaller's onefile bootstrap grandchild.
    Harmless in manual runs: an interactive tty never sends EOF.
    """
    try:
        while sys.stdin.readline():
            pass
    except Exception:
        pass
    os._exit(0)


def run(port: int) -> None:
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        # Most commonly: the port is already taken by another bridge instance.
        print(f"LumenDeck bridge could not bind port {port}: {exc}. "
              f"Another bridge is probably already running — reusing it.", flush=True)
        return
    print(f"LumenDeck bridge on http://127.0.0.1:{port}", flush=True)
    _refresh_diffusers_cache_async()  # warm the status cache so /health is honest fast
    server.serve_forever()


def main(argv=None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    port = int(os.environ.get("PORT", "8787"))
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    # Opt-in stdin watchdog: only the managed launchers (Tauri sidecar, Vite dev
    # plugin) set LUMENDECK_PARENT_WATCH and keep stdin open, so the bridge exits
    # with them. Standalone runs (run.bat, manual) never enable it and stay up
    # until the window/terminal is closed.
    if os.environ.get("LUMENDECK_PARENT_WATCH") == "1" and not sys.stdin.isatty():
        threading.Thread(target=_watch_parent_via_stdin, daemon=True).start()
    run(port)


if __name__ == "__main__":
    main()
