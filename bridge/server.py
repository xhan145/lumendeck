"""Pure-stdlib LumenDeck bridge (no third-party deps) for PyInstaller bundling.

Exposes the same contract as the old FastAPI bridge:
  GET  /health   -> {"status":"ok","adapter":"procedural","diffusers":bool}
  GET  /models   -> ModelAsset[]
  POST /generate -> {"image_base64": "...", "seed": int}

`build_response` is a pure function so it can be unit-tested without binding a socket.
"""
from __future__ import annotations

import json
import os
import sys
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
        payload = {"status": "ok", "adapter": "procedural", "diffusers": _diffusers_available()}
        return 200, headers, json.dumps(payload).encode()

    if method == "GET" and path == "/models":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(get_shelf()).encode()

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


def run(port: int) -> None:
    print(f"LumenDeck bridge on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main(argv=None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    port = int(os.environ.get("PORT", "8787"))
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    run(port)


if __name__ == "__main__":
    main()
