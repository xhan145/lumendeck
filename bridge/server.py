"""Pure-stdlib LumenDeck bridge (no third-party deps) for PyInstaller bundling.

Exposes the same contract as the old FastAPI bridge:
  GET  /health   -> {"status":"ok","adapter":"procedural","diffusers":bool}
  GET  /models   -> ModelAsset[]
  GET  /diffusers/status -> Diffusers dependency/model status
  POST /diffusers/download -> download/load the configured Diffusers model
  POST /generate -> {"image_base64": "...", "seed": int}

`build_response` is a pure function so it can be unit-tested without binding a socket.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from renderer import RenderRequest, render_png_base64
from scanner import get_shelf

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

    if method == "POST" and path == "/generate":
        headers["Content-Type"] = "application/json"
        try:
            job = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        mode = str(job.get("renderer", "auto"))
        if mode in ("diffusers", "auto") and _diffusers_available():
            try:
                return 200, headers, json.dumps(diffusers_backend.generate(job)).encode()
            except Exception as exc:  # fall back to procedural on any inference error
                if mode == "diffusers":
                    return 503, headers, json.dumps({"error": f"diffusers failed: {exc}"}).encode()
        if mode == "diffusers" and not _diffusers_available():
            return 503, headers, json.dumps({"error": "diffusers/torch not installed on the bridge"}).encode()
        return 200, headers, json.dumps(_procedural(job)).encode()

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
        self._send(*build_response("GET", self.path, b""))

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
    # Only arm the stdin watchdog when stdin is a pipe (i.e. launched by Tauri),
    # never for an interactive terminal.
    if not sys.stdin.isatty():
        threading.Thread(target=_watch_parent_via_stdin, daemon=True).start()
    run(port)


if __name__ == "__main__":
    main()
