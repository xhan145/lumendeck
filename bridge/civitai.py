"""Civitai model/LoRA browsing + download (pure standard library).

Search and download run on the bridge (server-side urllib) so the browser never
hits CORS, and large downloads stream to disk with progress. No third-party deps,
so this works inside the frozen sidecar too.
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any, Callable

API = "https://civitai.com/api/v1/models"
USER_AGENT = "LumenDeck/0.3 (+https://github.com/xhan145/lumendeck)"


def _request(url: str, token: str = "") -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def _first_image(version: dict) -> str:
    for img in version.get("images", []) or []:
        url = img.get("url")
        if url:
            return url
    return ""


def _primary_file(version: dict) -> dict | None:
    files = version.get("files", []) or []
    for f in files:
        if f.get("primary") and str(f.get("name", "")).lower().endswith((".safetensors", ".ckpt", ".pt")):
            return f
    for f in files:
        if str(f.get("name", "")).lower().endswith((".safetensors", ".ckpt", ".pt")):
            return f
    return files[0] if files else None


def simplify(payload: dict) -> list[dict]:
    """Flatten Civitai's model→version→file tree into shelf-ready rows."""
    out: list[dict] = []
    for model in payload.get("items", []) or []:
        version = (model.get("modelVersions") or [None])[0]
        if not version:
            continue
        file = _primary_file(version)
        if not file or not file.get("downloadUrl"):
            continue
        out.append({
            "modelId": model.get("id"),
            "name": model.get("name", "Untitled"),
            "type": model.get("type", ""),          # Checkpoint | LORA | ...
            "nsfw": bool(model.get("nsfw", False)),
            "baseModel": version.get("baseModel", ""),  # e.g. "SDXL 1.0", "Pony", "SD 1.5"
            "versionId": version.get("id"),
            "fileName": file.get("name", ""),
            "sizeKB": file.get("sizeKB", 0),
            "downloadUrl": file.get("downloadUrl", ""),
            "thumbnail": _first_image(version),
            "downloads": (model.get("stats") or {}).get("downloadCount", 0),
        })
    return out


def search(query: str, types: str = "Checkpoint", limit: int = 24, token: str = "", nsfw: bool = True) -> list[dict]:
    params = {
        "limit": max(1, min(50, int(limit))),
        "sort": "Most Downloaded",
    }
    if query:
        params["query"] = query
    if types:
        params["types"] = types  # Checkpoint | LORA
    if not nsfw:
        params["nsfw"] = "false"
    url = f"{API}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(_request(url, token), timeout=20) as resp:
        payload = json.loads(resp.read())
    return simplify(payload)


def download(download_url: str, dest_path: str, token: str = "",
             progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    """Stream a Civitai file to dest_path, reporting (received, total) bytes."""
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    tmp = dest_path + ".part"
    req = _request(download_url, token)
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        received = 0
        with open(tmp, "wb") as fh:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                fh.write(chunk)
                received += len(chunk)
                if progress:
                    progress(received, total)
    os.replace(tmp, dest_path)
    return {"path": dest_path, "bytes": os.path.getsize(dest_path)}
