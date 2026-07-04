"""Local model shelf scanner.

Scans LUMENDECK_MODEL_DIR for checkpoint/LoRA files, hashing each and inferring
its family from the filename. Returns the same ModelAsset shape the front-end
expects from /models. Falls back to a demo catalog when no directory is set.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

CHECKPOINT_EXTS = {".safetensors", ".ckpt", ".pt", ".pth"}
CHECKPOINT_DIR_HINTS = ("checkpoint", "checkpoints", "models/stable-diffusion", "unet")
LORA_DIR_HINTS = ("lora", "loras")


def _app_data_dir() -> Path:
    base = os.environ.get("LUMENDECK_HOME") or os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "LumenDeck"
    return Path.home() / ".lumendeck"


def _settings_path() -> Path:
    return _app_data_dir() / "settings.json"


def _load_settings() -> dict:
    try:
        path = _settings_path()
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_settings(settings: dict) -> None:
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True), encoding="utf-8")


def configured_model_dir() -> str:
    env_dir = os.environ.get("LUMENDECK_MODEL_DIR", "").strip()
    if env_dir:
        return env_dir
    value = _load_settings().get("modelDir", "")
    return str(value).strip() if isinstance(value, str) else ""


def set_configured_model_dir(path: str) -> dict:
    normalized = os.path.abspath(os.path.expanduser(path.strip())) if path.strip() else ""
    if normalized and not os.path.isdir(normalized):
        raise ValueError(f"Folder does not exist: {normalized}")
    settings = _load_settings()
    if normalized:
        settings["modelDir"] = normalized
        os.environ["LUMENDECK_MODEL_DIR"] = normalized
    else:
        settings.pop("modelDir", None)
        os.environ.pop("LUMENDECK_MODEL_DIR", None)
    _save_settings(settings)
    return model_dir_status()


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


def candidate_dirs() -> list[str]:
    """Model folders to auto-scan, most specific first.

    LUMENDECK_MODEL_DIR wins; otherwise probe common local installs (ComfyUI,
    A1111/Forge, InvokeAI, Fooocus) so real checkpoints show up with no config.
    """
    home = os.path.expanduser("~")
    dirs = [configured_model_dir()]
    for rel in (
        ("ComfyUI", "models"),
        ("comfyui", "models"),
        ("stable-diffusion-webui", "models", "Stable-diffusion"),
        ("stable-diffusion-webui-forge", "models", "Stable-diffusion"),
        ("InvokeAI", "models"),
        ("Fooocus", "models"),
    ):
        dirs.append(os.path.join(home, *rel))
    dirs += [
        r"C:\ComfyUI\models",
        r"C:\stable-diffusion-webui\models\Stable-diffusion",
    ]
    return [d for d in dirs if d]


def discover_model_dir() -> str | None:
    """First candidate directory that exists and holds at least one model file."""
    for d in candidate_dirs():
        if os.path.isdir(d) and scan_models(d):
            return d
    return None


def get_shelf() -> list[dict]:
    found = discover_model_dir()
    if found:
        return scan_models(found)
    return demo_catalog()


def model_dir_status() -> dict:
    configured = configured_model_dir()
    active = discover_model_dir()
    assets = scan_models(active) if active else []
    return {
        "configured": configured,
        "active": active or "",
        "assetCount": len(assets),
        "checkpointCount": len([a for a in assets if a.get("assetType") == "checkpoint"]),
        "loraCount": len([a for a in assets if a.get("assetType") == "lora"]),
        "usingDemo": active is None,
        "candidates": candidate_dirs(),
    }
