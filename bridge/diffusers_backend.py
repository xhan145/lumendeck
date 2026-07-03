"""Optional real text-to-image via Diffusers + SD-Turbo.

Lazily imported; the bridge works fully without it. Weights download to the Hugging
Face cache when ``download_model`` or ``generate`` first loads the pipeline. Guidance
is 0 and steps are low (SD-Turbo is a distilled, few-step model), so it is usable,
if slow, on CPU.
"""
from __future__ import annotations

import base64
import importlib.metadata
import io
import os
from pathlib import Path
from typing import Any

_MODEL_ID = os.environ.get("LUMENDECK_DIFFUSERS_MODEL", "stabilityai/sd-turbo")
_INSTALL_COMMAND = "python -m pip install torch diffusers transformers accelerate"
_pipe = None


def model_id() -> str:
    return _MODEL_ID


def _module_info(module_name: str, package_name: str | None = None) -> dict[str, Any]:
    package_name = package_name or module_name
    try:
        __import__(module_name)
        try:
            version = importlib.metadata.version(package_name)
        except importlib.metadata.PackageNotFoundError:
            version = None
        return {"installed": True, "version": version}
    except Exception as exc:
        return {"installed": False, "error": str(exc)}


def _torch_device() -> tuple[str, bool]:
    try:
        import torch

        cuda = bool(torch.cuda.is_available())
        return ("cuda" if cuda else "cpu"), cuda
    except Exception:
        return "unknown", False


def _cache_dir() -> str:
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return str(Path(hf_home))
    return str(Path.home() / ".cache" / "huggingface")


def _model_cached() -> bool | None:
    try:
        from huggingface_hub import try_to_load_from_cache

        # The "known to not exist" sentinel moved between huggingface_hub versions;
        # import it defensively so cache detection never crashes to None.
        sentinel = object()
        for mod in ("huggingface_hub.constants", "huggingface_hub.utils", "huggingface_hub"):
            try:
                sentinel = __import__(mod, fromlist=["_CACHED_NO_EXIST"])._CACHED_NO_EXIST
                break
            except Exception:
                continue

        cached = try_to_load_from_cache(_MODEL_ID, "model_index.json")
        if cached is None or cached is sentinel:
            return False
        return True
    except Exception:
        return None


def dependency_status() -> dict[str, Any]:
    torch_info = _module_info("torch")
    diffusers_info = _module_info("diffusers")
    device, cuda = _torch_device()
    return {
        "torch": torch_info,
        "diffusers": diffusers_info,
        "ready": bool(torch_info["installed"] and diffusers_info["installed"]),
        "device": device,
        "cuda": cuda,
        "installCommand": _INSTALL_COMMAND,
    }


def model_status() -> dict[str, Any]:
    dependencies = dependency_status()
    cached = _model_cached() if dependencies["ready"] else None
    loaded = _pipe is not None
    if not dependencies["ready"]:
        message = "Install torch and diffusers before downloading the real photo model."
    elif loaded:
        message = "SD-Turbo is loaded and ready for real photo renders."
    elif cached:
        message = "SD-Turbo is downloaded. The first real render will load it into memory."
    else:
        message = "SD-Turbo is not downloaded yet."
    return {
        "modelId": _MODEL_ID,
        "dependenciesReady": bool(dependencies["ready"]),
        "loaded": loaded,
        "modelCached": cached,
        "device": dependencies["device"],
        "cuda": dependencies["cuda"],
        "cacheDir": _cache_dir(),
        "installCommand": _INSTALL_COMMAND,
        "message": message,
        "dependencies": dependencies,
    }


def is_available() -> bool:
    return bool(dependency_status()["ready"])


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    import torch
    from diffusers import AutoPipelineForText2Image

    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    pipe = AutoPipelineForText2Image.from_pretrained(_MODEL_ID, torch_dtype=dtype)
    pipe = pipe.to("cuda" if torch.cuda.is_available() else "cpu")
    _pipe = pipe
    return pipe


def download_model() -> dict[str, Any]:
    if not is_available():
        raise RuntimeError(f"diffusers/torch not installed on the bridge. Run: {_INSTALL_COMMAND}")
    _load()
    status = model_status()
    return {**status, "message": "SD-Turbo downloaded and loaded for real photo renders."}


def generate(job: dict) -> dict:
    if not is_available():
        raise RuntimeError(f"diffusers/torch not installed on the bridge. Run: {_INSTALL_COMMAND}")
    import torch

    seed = int(job.get("seed", 0))
    if seed < 0:
        seed = 0
    pipe = _load()
    generator = torch.Generator(device=pipe.device).manual_seed(seed)
    steps = max(1, min(8, int(job.get("steps", 2))))
    image = pipe(
        prompt=str(job.get("prompt", "")),
        num_inference_steps=steps,
        guidance_scale=0.0,
        width=int(job.get("width", 512)),
        height=int(job.get("height", 512)),
        generator=generator,
    ).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"image_base64": base64.b64encode(buf.getvalue()).decode("ascii"), "seed": seed}
