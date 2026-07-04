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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from renderer import RenderRequest, render_png_base64
from scanner import get_shelf

# Built web app (from `npm run build`). When present, the bridge serves the whole
# UI on the same origin as the API, so the browser never makes a cross-origin call.
DIST_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dist"))
API_PREFIXES = ("/health", "/models", "/generate", "/diffusers", "/progress")

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
    status = _diffusers_status()
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


def _shelf_with_real() -> list:
    """Local scan (or demo) plus the real Diffusers model; real model first when usable."""
    shelf = list(get_shelf())
    entry = _diffusers_shelf_entry()
    if entry["installed"]:
        return [entry, *shelf]
    shelf.append(entry)
    return shelf


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
        payload = {"status": "ok", "adapter": "procedural", "diffusers": _diffusers_available(), "model": _diffusers_status()}
        return 200, headers, json.dumps(payload).encode()

    if method == "GET" and path == "/models":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(_shelf_with_real()).encode()

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
            return 200, headers, json.dumps(diffusers_backend.download_model()).encode()
        except Exception as exc:
            return 503, headers, json.dumps({"error": str(exc), "status": _diffusers_status()}).encode()

    if method == "POST" and path == "/diffusers/install":
        headers["Content-Type"] = "application/json"
        if not _HAS_DIFFUSERS_MODULE:
            return 503, headers, json.dumps({"error": "diffusers backend module is not available in this build"}).encode()
        try:
            return 200, headers, json.dumps(diffusers_backend.install_runtime()).encode()
        except Exception as exc:
            return 503, headers, json.dumps({"error": str(exc), "status": _diffusers_status()}).encode()

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
        if mode in ("diffusers", "auto") and _diffusers_available():
            try:
                result = diffusers_backend.generate(job)
                if track:
                    _write_progress(job_id, {"phase": "done"})
                return 200, headers, json.dumps(result).encode()
            except Exception as exc:  # fall back to procedural on any inference error
                import traceback
                print(f"[diffusers] render failed, falling back to procedural: {exc}", flush=True)
                traceback.print_exc()
                if mode == "diffusers":
                    if track:
                        _write_progress(job_id, {"phase": "error"})
                    return 503, headers, json.dumps({"error": f"diffusers failed: {exc}"}).encode()
        if mode == "diffusers" and not _diffusers_available():
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 503, headers, json.dumps({"error": "diffusers/torch not installed on the bridge"}).encode()
        result = _procedural(job)
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
