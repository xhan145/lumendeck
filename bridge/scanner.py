"""Local model shelf scanner.

Scans LUMENDECK_MODEL_DIR for checkpoint/LoRA files, hashing each and inferring
its family from the filename. Returns the same ModelAsset shape the front-end
expects from /models. Falls back to a demo catalog when no directory is set.
"""
from __future__ import annotations

import hashlib
import os

CHECKPOINT_EXTS = {".safetensors", ".ckpt", ".pt", ".pth"}
CHECKPOINT_DIR_HINTS = ("checkpoint", "checkpoints", "models/stable-diffusion", "unet")
LORA_DIR_HINTS = ("lora", "loras")


def _infer_family(name: str) -> str:
    low = name.lower()
    if "xl" in low or "sdxl" in low:
        return "SDXL"
    if "flux" in low:
        return "Flux"
    if "sd3" in low or "sd_3" in low:
        return "SD3"
    return "SD1.5"


def _short_hash(path: str) -> str:
    """Hash the first 8 MiB — enough to identify a file without reading GBs."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            h.update(fh.read(8 * 1024 * 1024))
    except OSError:
        return "0" * 16
    return h.hexdigest()[:16]


def _asset_type(path: str) -> str:
    low = path.lower().replace("\\", "/")
    if any(hint in low for hint in LORA_DIR_HINTS):
        return "lora"
    return "checkpoint"


def scan_models(root: str) -> list[dict]:
    assets: list[dict] = []
    for dirpath, _dirs, files in os.walk(root):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in CHECKPOINT_EXTS:
                continue
            full = os.path.join(dirpath, fname)
            try:
                size_mb = round(os.path.getsize(full) / (1024 * 1024))
            except OSError:
                size_mb = 0
            atype = _asset_type(full)
            family = _infer_family(fname)
            assets.append({
                "id": _short_hash(full),
                "assetType": atype,
                "name": os.path.splitext(fname)[0],
                "family": family,
                "path": os.path.relpath(full, root).replace("\\", "/"),
                "hash": _short_hash(full),
                "sizeMB": size_mb,
                "tags": ["scanned", family.lower()],
                "compatibility": f"Detected {family} {atype} from local scan.",
                "license": "unknown (local file)",
                "installed": True,
            })
    return assets


def demo_catalog() -> list[dict]:
    """Mirror of the front-end DEMO_SHELF so the bridge is usable without files."""
    return [
        {"id": "ckpt-lumen-xl", "assetType": "checkpoint", "name": "LumenXL v1.0", "family": "SDXL",
         "path": "models/checkpoints/lumenxl_v10.safetensors", "hash": "a1b2c3d4e5f60718", "sizeMB": 6620,
         "tags": ["general", "photoreal"], "compatibility": "SDXL LoRAs; native 1024.",
         "license": "CreativeML OpenRAIL++-M", "installed": True},
        {"id": "ckpt-drift-15", "assetType": "checkpoint", "name": "DiscoDrift 1.5", "family": "SD1.5",
         "path": "models/checkpoints/discodrift_15.safetensors", "hash": "9f8e7d6c5b4a3921", "sizeMB": 2130,
         "tags": ["artistic", "dreamlike"], "compatibility": "SD1.5 LoRAs; best 512-768.",
         "license": "CreativeML OpenRAIL-M", "installed": True},
        {"id": "lora-neon-bloom", "assetType": "lora", "name": "Neon Bloom", "family": "SDXL",
         "path": "models/loras/neon_bloom_xl.safetensors", "hash": "feedbeefcafe0101", "sizeMB": 228,
         "tags": ["neon", "glow"], "compatibility": "Pairs with LumenXL 0.6-0.9.",
         "license": "CC BY-NC 4.0", "installed": True},
        {"id": "lora-retro-grain", "assetType": "lora", "name": "Retro Grain 35mm", "family": "SD1.5",
         "path": "models/loras/retro_grain_35mm.safetensors", "hash": "0badc0de55aa77ff", "sizeMB": 86,
         "tags": ["film", "grain"], "compatibility": "SD1.5 only.",
         "license": "CreativeML OpenRAIL-M", "installed": True},
    ]


def get_shelf() -> list[dict]:
    root = os.environ.get("LUMENDECK_MODEL_DIR", "").strip()
    if root and os.path.isdir(root):
        scanned = scan_models(root)
        if scanned:
            return scanned
    return demo_catalog()
