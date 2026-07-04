"""Pure-stdlib LumenDeck bridge (no third-party deps) for PyInstaller bundling.

Exposes the same contract as the old FastAPI bridge:
  GET  /health   -> {"status":"ok","adapter":"procedural","diffusers":bool}
  GET  /models   -> ModelAsset[]
  GET  /diffusers/status -> Diffusers dependency/model status
  POST /diffusers/install -> install managed Diffusers runtime + model
  POST /diffusers/download -> download/load the configured Diffusers model
  POST /generate -> {"image_base64": "...", "seed": int}

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

from renderer import RenderRequest, render_png_base64
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

# Built web app (from `npm run build`). When present, the bridge serves the whole
# UI on the same origin as the API, so the browser never makes a cross-origin call.
DIST_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dist"))
API_PREFIXES = ("/health", "/models", "/model-folder", "/generate", "/diffusers", "/progress", "/civitai")


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
    """Drop stale progress files so temp doesn't accumulate them."""
    try:
        now = time.time()
        for name in os.listdir(tempfile.gettempdir()):
            if not name.startswith("lumendeck-progress-"):
                continue
            path = os.path.join(tempfile.gettempdir(), name)
            try:
                if now - os.path.getmtime(path) > max_age_s:
                    os.remove(path)
            except OSError:
                pass
    except OSError:
        pass

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


def _resolve_render_targets(job: dict, shelf: list, model_root: str | None) -> dict:
    """Annotate a render job with modelRef/loraFiles for the diffusers worker.

    Pure given its inputs (shelf list + scan root), so it is unit-testable.
    Unknown/demo assets resolve to the default hub model / are skipped.
    """
    assets = {str(a.get("id")): a for a in shelf}

    def abs_path(asset: dict) -> str | None:
        rel = str(asset.get("path", ""))
        if os.path.isabs(rel) and os.path.isfile(rel):
            return os.path.normpath(rel)
        if model_root:
            candidate = os.path.normpath(os.path.join(model_root, rel))
            if os.path.isfile(candidate):
                return candidate
        return None

    model_id = str(job.get("modelId") or "")
    if model_id in HUB_MODELS:
        hub = HUB_MODELS[model_id]
        job["modelRef"] = {"kind": "hub", "id": hub} if hub else {"kind": "hub"}
    else:
        asset = assets.get(model_id)
        path = abs_path(asset) if asset and asset.get("assetType") == "checkpoint" else None
        if path:
            job["modelRef"] = {"kind": "file", "path": path, "family": asset.get("family", "")}
        else:
            job["modelRef"] = {"kind": "hub"}  # default model

    lora_files = []
    for lora in job.get("loras") or []:
        asset = assets.get(str(lora.get("id")))
        if not asset or asset.get("assetType") != "lora":
            continue
        path = abs_path(asset)
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
    )
    return {"image_base64": render_png_base64(req), "seed": seed}


def build_response(method: str, path: str, body: bytes):
    """Return (status_code, headers_dict, body_bytes) for a request. Pure & testable."""
    headers = dict(CORS)
    if method == "OPTIONS":
        return 204, headers, b""

    if method == "GET" and path == "/health":
        headers["Content-Type"] = "application/json"
        available, status = _cached_diffusers()
        payload = {"status": "ok", "adapter": "procedural", "diffusers": available, "model": status}
        return 200, headers, json.dumps(payload).encode()

    if method == "GET" and path == "/models":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(_shelf_with_real()).encode()

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
                if mode == "diffusers":
                    if track:
                        _write_progress(job_id, {"phase": "error"})
                    return 503, headers, json.dumps({"error": f"diffusers failed: {exc}"}).encode()
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
        if track:
            _write_progress(job_id, {"phase": "done"})
        return 200, headers, json.dumps(result).encode()

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
        status, headers, body = build_response("GET", self.path, b"")
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
        self._send(*build_response("POST", self.path, self.rfile.read(length)))

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
