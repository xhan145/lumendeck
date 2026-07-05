"""Real text-to-image via an external Diffusers worker.

The bundled bridge stays tiny and portable. When the user asks for real photos,
it finds a compatible Python 3.10-3.13 runtime, installs missing Diffusers pieces
into an app-local package directory, and runs SD-Turbo in that Python process.
This avoids trying to import CPython extension wheels (torch/safetensors) into
the PyInstaller sidecar's own Python runtime.
"""
from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

_MODEL_ID = os.environ.get("LUMENDECK_DIFFUSERS_MODEL", "stabilityai/sd-turbo")
_TORCH_CPU_INDEX_URL = "https://download.pytorch.org/whl/cpu"
_TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu128"
_INSTALL_COMMAND = "Install runtime + model chooses CUDA PyTorch on NVIDIA GPUs, else CPU PyTorch."
_python_cache: dict[str, Any] | None | bool = False

_WORKER_SOURCE = r'''
from __future__ import annotations

import base64
import importlib.metadata
import importlib.util
import io
import json
import os
import struct
import sys
from pathlib import Path

SITE_DIR = Path(os.environ.get("LUMENDECK_DIFFUSERS_SITE", ""))
MODEL_ID = os.environ.get("LUMENDECK_DIFFUSERS_MODEL", "stabilityai/sd-turbo")
if SITE_DIR.exists() and str(SITE_DIR) not in sys.path:
    sys.path.insert(0, str(SITE_DIR))
if os.name == "nt":
    torch_lib = SITE_DIR / "torch" / "lib"
    if torch_lib.exists() and hasattr(os, "add_dll_directory"):
        try:
            os.add_dll_directory(str(torch_lib))
        except OSError:
            pass


def module_info(module_name, package_name=None):
    package_name = package_name or module_name
    try:
        spec = importlib.util.find_spec(module_name)
    except Exception as exc:
        return {"installed": False, "error": str(exc)}
    if spec is None:
        return {"installed": False}
    try:
        version = importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        version = None
    try:
        module = __import__(module_name)
    except Exception as exc:
        return {"installed": True, "version": version, "importable": False, "error": str(exc)}
    return {"installed": True, "version": version, "importable": True, "module": module}


def cache_dir():
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return str(Path(hf_home))
    return str(Path.home() / ".cache" / "huggingface")


def model_cached():
    try:
        from huggingface_hub import try_to_load_from_cache
        sentinel = object()
        for mod in ("huggingface_hub.constants", "huggingface_hub.utils", "huggingface_hub"):
            try:
                sentinel = __import__(mod, fromlist=["_CACHED_NO_EXIST"])._CACHED_NO_EXIST
                break
            except Exception:
                continue
        cached = try_to_load_from_cache(MODEL_ID, "model_index.json")
        if cached is None or cached is sentinel:
            return False
        return True
    except Exception:
        return None


def status(message=None, loaded=False):
    torch_info = module_info("torch")
    diffusers_info = module_info("diffusers")
    torch = torch_info.pop("module", None)
    diffusers_info.pop("module", None)
    ready = bool(torch_info.get("importable") and diffusers_info.get("importable"))
    device = "unknown"
    cuda = False
    if torch is not None:
        try:
            cuda = bool(torch.cuda.is_available())
            device = "cuda" if cuda else "cpu"
        except Exception:
            pass
    if message is None:
        if not ready:
            message = "Install the managed Diffusers runtime, then download SD-Turbo for real photo renders."
        elif loaded:
            message = "SD-Turbo is loaded and ready for real photo renders."
        elif model_cached():
            message = "SD-Turbo is downloaded. The next real render will load it into memory."
        else:
            message = "SD-Turbo is not downloaded yet."
    return {
        "modelId": MODEL_ID,
        "dependenciesReady": ready,
        "loaded": loaded,
        "modelCached": model_cached() if ready else None,
        "device": device,
        "cuda": cuda,
        "cacheDir": cache_dir(),
        "installCommand": "Install runtime + model chooses CUDA PyTorch on NVIDIA GPUs, else CPU PyTorch.",
        "message": message,
        "dependencies": {
            "torch": torch_info,
            "diffusers": diffusers_info,
            "ready": ready,
            "device": device,
            "cuda": cuda,
        },
    }


def detect_single_file_family(path):
    """Read the .safetensors header (tensor names only, no data) to tell SDXL from SD1.5.

    Filenames lie ('cyberrealisticPony' is SDXL), so inspect the actual weights.
    Returns 'SDXL' | 'SD1.5' | None (unreadable)."""
    try:
        with open(path, "rb") as fh:
            n = struct.unpack("<Q", fh.read(8))[0]
            header = json.loads(fh.read(n))
        keys = header.keys()
        if any(("conditioner.embedders.1" in k) or ("add_embedding" in k) or (".label_emb." in k) for k in keys):
            return "SDXL"
        return "SD1.5"
    except Exception:
        return None


def load_pipe(model_ref=None):
    import torch
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    ref = model_ref or {"kind": "hub", "id": MODEL_ID}
    if ref.get("kind") == "file":
        path = str(ref.get("path", ""))
        detected = detect_single_file_family(path)
        if detected:
            is_xl = detected == "SDXL"
        else:
            family = str(ref.get("family", "")).upper()
            is_xl = "XL" in family or "xl" in Path(path).name.lower()
        if is_xl:
            from diffusers import StableDiffusionXLPipeline as PipeCls
        else:
            from diffusers import StableDiffusionPipeline as PipeCls
        pipe = PipeCls.from_single_file(path, torch_dtype=dtype)
    else:
        from diffusers import AutoPipelineForText2Image
        pipe = AutoPipelineForText2Image.from_pretrained(ref.get("id") or MODEL_ID, torch_dtype=dtype)
    pipe = pipe.to("cuda" if torch.cuda.is_available() else "cpu")
    # Fit large models (SDXL) into modest VRAM (e.g. 8 GB laptop GPUs).
    for enable in ("enable_attention_slicing", "enable_vae_slicing", "enable_vae_tiling"):
        try:
            getattr(pipe, enable)()
        except Exception:
            pass
    return pipe


def apply_loras(pipe, lora_files):
    """Load scanned LoRA files onto the pipe with independent weights. Best-effort."""
    names, weights = [], []
    for index, lora in enumerate(lora_files or []):
        try:
            name = f"lora{index}"
            pipe.load_lora_weights(str(lora["path"]), adapter_name=name)
            names.append(name)
            weights.append(float(lora.get("weight", 1.0)))
        except Exception as exc:
            print(f"[worker] skipping LoRA {lora.get('path')}: {exc}", file=sys.stderr, flush=True)
    if names:
        try:
            pipe.set_adapters(names, weights)
        except Exception as exc:
            print(f"[worker] set_adapters failed: {exc}", file=sys.stderr, flush=True)


def _ref_key(ref):
    if ref.get("kind") == "file":
        return "file:" + str(ref.get("path", ""))
    return "hub:" + str(ref.get("id") or MODEL_ID)


_MOTION_ADAPTERS = {
    "SD1.5": "guoyww/animatediff-motion-adapter-v1-5-2",
    "SDXL": "guoyww/animatediff-motion-adapter-sdxl-beta",
}


def _model_family(model_ref):
    if model_ref.get("kind") == "file":
        det = detect_single_file_family(str(model_ref.get("path", "")))
        if det:
            return det
        return "SDXL" if "xl" in str(model_ref.get("family", "")).lower() else "SD1.5"
    return "SDXL" if "xl" in str(model_ref.get("id") or MODEL_ID).lower() else "SD1.5"


def load_animate_pipe(model_ref):
    """Build an AnimateDiff pipeline on the SELECTED checkpoint + a motion adapter,
    so video animates the real model. SD1.5 is the primary path; SDXL is beta."""
    import torch
    from diffusers import MotionAdapter
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    device = "cuda" if torch.cuda.is_available() else "cpu"
    family = _model_family(model_ref)
    adapter = MotionAdapter.from_pretrained(_MOTION_ADAPTERS[family], torch_dtype=dtype)
    if family == "SDXL":
        from diffusers import AnimateDiffSDXLPipeline, StableDiffusionXLPipeline
        if model_ref.get("kind") == "file":
            base = StableDiffusionXLPipeline.from_single_file(str(model_ref["path"]), torch_dtype=dtype)
            pipe = AnimateDiffSDXLPipeline.from_pipe(base, motion_adapter=adapter)
        else:
            pipe = AnimateDiffSDXLPipeline.from_pretrained(model_ref.get("id") or MODEL_ID, motion_adapter=adapter, torch_dtype=dtype)
    else:
        from diffusers import AnimateDiffPipeline, DDIMScheduler, StableDiffusionPipeline
        if model_ref.get("kind") == "file":
            base = StableDiffusionPipeline.from_single_file(str(model_ref["path"]), torch_dtype=dtype)
            pipe = AnimateDiffPipeline.from_pipe(base, motion_adapter=adapter)
        else:
            pipe = AnimateDiffPipeline.from_pretrained(model_ref.get("id") or MODEL_ID, motion_adapter=adapter, torch_dtype=dtype)
        # AnimateDiff needs a linear-beta DDIM scheduler for coherent motion.
        pipe.scheduler = DDIMScheduler.from_config(
            pipe.scheduler.config, beta_schedule="linear", timestep_spacing="linspace", clip_sample=False,
        )
    for enable in ("enable_vae_slicing", "enable_vae_tiling", "enable_attention_slicing"):
        try:
            getattr(pipe, enable)()
        except Exception:
            pass
    # AnimateDiff's temporal UNet is VRAM-heavy; CPU offload keeps only the active
    # module on the GPU so it fits ~8 GB cards (slower, but it actually finishes).
    if device == "cuda":
        try:
            pipe.enable_model_cpu_offload()
        except Exception:
            pipe = pipe.to(device)
    else:
        pipe = pipe.to(device)
    return pipe


def _animate(job, state, report):
    """Real text->video via AnimateDiff, exported as an animated GIF (Pillow)."""
    import torch
    model_ref = job.get("modelRef") or {"kind": "hub", "id": MODEL_ID}
    key = "anim:" + _ref_key(model_ref)
    if state.get("anim_key") != key or state.get("anim_pipe") is None:
        report({"phase": "loading"})
        # Free the still-image pipe (and any old animate pipe) to conserve VRAM.
        state["pipe"] = None
        state["key"] = None
        state["anim_pipe"] = None
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        state["anim_pipe"] = load_animate_pipe(model_ref)
        state["anim_key"] = key
    pipe = state["anim_pipe"]

    seed = int(job.get("seed", 0))
    if seed < 0:
        seed = 0
    # With CPU offload the pipe's device is managed dynamically; pin the generator
    # to the real compute device rather than pipe.device (which may be 'cpu'/'meta').
    gen_device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = torch.Generator(device=gen_device).manual_seed(seed)
    frames_n = max(8, min(32, int(job.get("frameCount", 16))))
    steps = max(1, min(40, int(job.get("steps", 25))))
    guidance = float(job.get("cfg", 7.5))
    fps = max(1, min(30, int(job.get("fps", 8))))
    report({"phase": "rendering", "step": 0, "steps": steps})

    def on_step(_pipe, step, _timestep, callback_kwargs):
        report({"phase": "rendering", "step": int(step) + 1, "steps": steps})
        return callback_kwargs

    kwargs = dict(
        prompt=str(job.get("prompt", "")),
        negative_prompt=str(job.get("negativePrompt", "")) or None,
        num_frames=frames_n,
        num_inference_steps=steps,
        guidance_scale=guidance,
        width=int(job.get("width", 512)),
        height=int(job.get("height", 512)),
        generator=generator,
    )
    try:
        result = pipe(**kwargs, callback_on_step_end=on_step)
    except TypeError:
        result = pipe(**kwargs)
    frames = result.frames[0]
    report({"phase": "done", "step": steps, "steps": steps})
    buf = io.BytesIO()
    loop = 0 if job.get("loop", True) else 1
    frames[0].save(
        buf, format="GIF", save_all=True, append_images=frames[1:],
        duration=int(1000 / fps), loop=loop, disposal=2,
    )
    return {
        "video_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "seed": seed,
        "mediaType": "video",
        "mimeType": "image/gif",
        "extension": "gif",
        "engine": "animatediff",
    }


def do_generate(job, state):
    """Render one image, reusing state['pipe'] when the model hasn't changed.

    `state` persists across calls in serve mode, so the (multi-GB) model loads once
    and only reloads when you switch checkpoints. In one-shot mode it's a fresh dict.
    """
    progress_path = job.get("progressPath")

    def report(data):
        if not progress_path:
            return
        try:
            with open(progress_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        except OSError:
            pass

    if str(job.get("output", "image")) == "video":
        return _animate(job, state, report)

    import torch
    model_ref = job.get("modelRef") or {"kind": "hub", "id": MODEL_ID}
    key = _ref_key(model_ref)
    if state.get("key") != key or state.get("pipe") is None:
        report({"phase": "loading"})
        if state.get("pipe") is not None:
            state["pipe"] = None
            state["lora_key"] = None
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        state["pipe"] = load_pipe(model_ref)
        state["key"] = key
        state["lora_key"] = None
    pipe = state["pipe"]

    lora_key = json.dumps(job.get("loraFiles") or [], sort_keys=True)
    if state.get("lora_key") != lora_key:
        try:
            pipe.unload_lora_weights()
        except Exception:
            pass
        apply_loras(pipe, job.get("loraFiles"))
        state["lora_key"] = lora_key

    seed = int(job.get("seed", 0))
    if seed < 0:
        seed = 0
    generator = torch.Generator(device=pipe.device).manual_seed(seed)
    effective_id = str(model_ref.get("id") or MODEL_ID)
    is_turbo = model_ref.get("kind") != "file" and "turbo" in effective_id.lower()
    if is_turbo:
        steps = max(1, min(8, int(job.get("steps", 2))))
        guidance = 0.0
    else:
        steps = max(1, min(50, int(job.get("steps", 25))))
        guidance = float(job.get("cfg", 7.0))
    report({"phase": "rendering", "step": 0, "steps": steps})

    def on_step(_pipe, step, _timestep, callback_kwargs):
        report({"phase": "rendering", "step": int(step) + 1, "steps": steps})
        return callback_kwargs

    width, height = int(job.get("width", 512)), int(job.get("height", 512))
    init_b64 = job.get("initImage")
    mask_b64 = job.get("maskImage")

    if init_b64:
        # img2img / inpaint: reuse the loaded checkpoint's weights via from_pipe
        # (no reload), just a different pipeline class.
        from PIL import Image
        is_xl = _model_family(model_ref) == "SDXL"

        def _decode(b64):
            raw = base64.b64decode(str(b64).split(",")[-1])
            return Image.open(io.BytesIO(raw)).convert("RGB").resize((width, height))

        init_img = _decode(init_b64)
        strength = max(0.05, min(1.0, float(job.get("denoise", 0.6))))
        common = dict(
            prompt=str(job.get("prompt", "")),
            negative_prompt=str(job.get("negativePrompt", "")) or None,
            num_inference_steps=steps,
            guidance_scale=guidance,
            strength=strength,
            generator=generator,
        )
        if mask_b64:
            from diffusers import StableDiffusionInpaintPipeline, StableDiffusionXLInpaintPipeline
            InpaintCls = StableDiffusionXLInpaintPipeline if is_xl else StableDiffusionInpaintPipeline
            task_pipe = InpaintCls.from_pipe(pipe)
            call = dict(image=init_img, mask_image=_decode(mask_b64), width=width, height=height, **common)
        else:
            from diffusers import StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline
            Img2ImgCls = StableDiffusionXLImg2ImgPipeline if is_xl else StableDiffusionImg2ImgPipeline
            task_pipe = Img2ImgCls.from_pipe(pipe)
            call = dict(image=init_img, **common)
        try:
            image = task_pipe(**call, callback_on_step_end=on_step).images[0]
        except TypeError:
            image = task_pipe(**call).images[0]
    else:
        kwargs = dict(
            prompt=str(job.get("prompt", "")),
            negative_prompt=str(job.get("negativePrompt", "")) or None,
            num_inference_steps=steps,
            guidance_scale=guidance,
            width=width,
            height=height,
            generator=generator,
        )
        try:
            image = pipe(**kwargs, callback_on_step_end=on_step).images[0]
        except TypeError:
            image = pipe(**kwargs).images[0]

    report({"phase": "done", "step": steps, "steps": steps})
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"image_base64": base64.b64encode(buf.getvalue()).decode("ascii"), "seed": seed}


def serve():
    """Persistent request loop: keeps the model resident across renders.

    Reads one JSON request per stdin line, writes one marker-prefixed JSON result
    per line to stdout (progress bars/warnings go to stderr, so stdout stays clean).
    Exits on stdin EOF — i.e. when the bridge that owns this pipe goes away.
    """
    marker = "@@LD_RESULT@@"
    state = {"pipe": None, "key": None, "lora_key": None}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            command = req.get("command")
            payload = req.get("payload") or {}
            if command == "generate":
                out = do_generate(payload, state)
            elif command == "ping":
                out = {"ok": True}
            elif command == "status":
                out = status()
            else:
                out = {"error": f"unknown command: {command}"}
        except Exception as exc:
            import traceback
            traceback.print_exc()
            out = {"error": str(exc)}
        sys.stdout.write(marker + json.dumps(out) + "\n")
        sys.stdout.flush()


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "serve":
        serve()
        return
    if command == "status":
        print(json.dumps(status()))
        return
    if command == "download":
        load_pipe()
        print(json.dumps(status("SD-Turbo downloaded and loaded for real photo renders.", loaded=True)))
        return
    if command == "generate":
        out = do_generate(json.load(sys.stdin), {"pipe": None, "key": None, "lora_key": None})
        print(json.dumps(out))
        return
    raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main()
'''


def model_id() -> str:
    return _MODEL_ID


def _app_data_dir() -> Path:
    base = os.environ.get("LUMENDECK_HOME") or os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "LumenDeck"
    return Path.home() / ".lumendeck"


def _runtime_dir() -> Path:
    configured = os.environ.get("LUMENDECK_DIFFUSERS_RUNTIME") or os.environ.get("LUMENDECK_DIFFUSERS_VENV")
    return Path(configured) if configured else _app_data_dir() / "diffusers-runtime"


def _site_dir() -> Path:
    return _runtime_dir() / "site-packages"


def _worker_path() -> Path:
    return _runtime_dir() / "diffusers_worker.py"



def _python_manifest_path() -> Path:
    return _runtime_dir() / "python.json"


def _read_python_manifest() -> dict[str, Any] | None:
    try:
        data = json.loads(_python_manifest_path().read_text(encoding="utf-8"))
        cmd = data.get("cmd")
        if isinstance(cmd, list) and all(isinstance(part, str) for part in cmd):
            found = _probe_python(cmd)
            if found:
                return found
    except Exception:
        pass
    return None


def _write_python_manifest(python: dict[str, Any]) -> None:
    try:
        _runtime_dir().mkdir(parents=True, exist_ok=True)
        _python_manifest_path().write_text(
            json.dumps({"cmd": python["cmd"], "version": python["version"]}, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


def _python_major_minor(python: dict[str, Any]) -> str:
    return ".".join(str(python.get("version", "")).split(".")[:2])


def _managed_runtime_python_version() -> str | None:
    site = _site_dir()
    if not site.exists():
        return None
    for info in site.glob("torch-*.dist-info"):
        wheel = info / "WHEEL"
        if not wheel.exists():
            continue
        for line in wheel.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.lower().startswith("tag:"):
                match = re.search(r"cp3(\d+)", line)
                if match:
                    return f"3.{match.group(1)}"
    return None


def _managed_runtime_matches(python: dict[str, Any]) -> bool:
    managed_version = _managed_runtime_python_version()
    return bool(managed_version and _python_major_minor(python) == managed_version)


def _write_worker() -> Path:
    runtime = _runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    worker = _worker_path()
    if not worker.exists() or worker.read_text(encoding="utf-8") != _WORKER_SOURCE:
        worker.write_text(_WORKER_SOURCE, encoding="utf-8")
    return worker


def _run(cmd: list[str], timeout: int = 1200, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=True,
    )


_native_torch_cache: dict[str, bool] = {}


def _python_has_native_torch(python: dict[str, Any]) -> bool:
    """True when this interpreter can import torch without the managed site dir."""
    key = " ".join(python["cmd"])
    if key not in _native_torch_cache:
        try:
            _run(python["cmd"] + ["-c", "import torch, diffusers"], timeout=180)
            _native_torch_cache[key] = True
        except Exception:
            _native_torch_cache[key] = False
    return _native_torch_cache[key]


def _base_python_has_module(module_name: str) -> bool:
    python = _find_python()
    if not python:
        return False
    try:
        _run(python["cmd"] + ["-c", f"import {module_name}"], timeout=120)
        return True
    except Exception:
        return False


def _has_nvidia_gpu() -> bool:
    if os.environ.get("LUMENDECK_TORCH_DEVICE", "").lower() == "cpu":
        return False
    if os.environ.get("LUMENDECK_TORCH_DEVICE", "").lower() == "cuda":
        return True
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return False
    try:
        proc = _run([nvidia_smi, "--query-gpu=name", "--format=csv,noheader"], timeout=10)
        return bool(proc.stdout.strip())
    except Exception:
        return False


def _torch_index_url() -> str:
    configured = os.environ.get("LUMENDECK_TORCH_INDEX_URL")
    if configured:
        return configured
    return _TORCH_CUDA_INDEX_URL if _has_nvidia_gpu() else _TORCH_CPU_INDEX_URL


def _torch_target_label() -> str:
    return "cuda" if _torch_index_url() != _TORCH_CPU_INDEX_URL else "cpu"


def _reset_site_dir() -> None:
    site = _site_dir()
    if site.exists():
        shutil.rmtree(site, ignore_errors=True)
    site.mkdir(parents=True, exist_ok=True)


def _remove_target_package(package_name: str) -> None:
    site = _site_dir()
    if not site.exists():
        return
    for path in site.glob(f"{package_name}*"):
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                path.unlink()
            except OSError:
                pass


def _probe_python(cmd: list[str]) -> dict[str, Any] | None:
    try:
        proc = _run(cmd + ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], timeout=20)
        version_text = proc.stdout.strip().splitlines()[-1]
        parts = tuple(int(part) for part in version_text.split(".")[:3])
        if parts < (3, 10) or parts >= (3, 15):
            return None
        return {"cmd": cmd, "version": version_text}
    except Exception:
        return None


def _candidate_paths() -> list[Path]:
    roots = []
    home = Path.home()
    env_python = os.environ.get("LUMENDECK_PYTHON")
    if env_python:
        roots.append(Path(env_python))
    for prefix in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), "C:\\"):
        if prefix:
            for version in ("312", "311", "310"):
                roots.append(Path(prefix) / "Programs" / "Python" / f"Python{version}" / "python.exe")
                roots.append(Path(prefix) / f"Python{version}" / "python.exe")
    for base in (home / "OneDrive" / "Documents", home / "Documents", home):
        roots.extend(
            [
                base / "New project" / "AI" / "sd.webui" / "system" / "python" / "python.exe",
                base / "AI" / "sd.webui" / "system" / "python" / "python.exe",
                base / "sd.webui" / "system" / "python" / "python.exe",
                base / "stable-diffusion-webui" / "venv" / "Scripts" / "python.exe",
                base / "ComfyUI" / "python_embeded" / "python.exe",
            ]
        )
    seen = set()
    out = []
    for path in roots:
        key = str(path).lower()
        if key not in seen and path.exists():
            seen.add(key)
            out.append(path)
    return out


def _managed_runtime_python() -> dict[str, Any] | None:
    """Interpreter matching the managed CUDA runtime's ABI.

    The managed runtime installs CUDA torch for one Python version. Prefer the
    exact interpreter recorded at install time, then fall back to version-matched
    Python candidates. This prevents CPU-only system torch from shadowing the
    app-local CUDA torch.
    """
    manifest_python = _read_python_manifest()
    if manifest_python and _managed_runtime_matches(manifest_python):
        return manifest_python

    ver = _managed_runtime_python_version()
    if not ver:
        return None

    candidates: list[list[str]] = []
    if os.name == "nt":
        candidates.append(["py", f"-{ver}"])
    candidates.append([f"python{ver}"])
    candidates.extend([[str(path)] for path in _candidate_paths()])

    for candidate in candidates:
        found = _probe_python(candidate)
        if found and _managed_runtime_matches(found):
            return found
    return None

def _find_python() -> dict[str, Any] | None:
    global _python_cache
    if _python_cache is not False:
        return _python_cache

    # Absolute override must win. This is the escape hatch for broken py-launcher
    # setups and embedded Python installs.
    env_python = os.environ.get("LUMENDECK_PYTHON")
    if env_python:
        found = _probe_python([env_python])
        if found:
            _python_cache = found
            return found

    # Highest priority after explicit override: the interpreter matching the
    # managed CUDA runtime, so GPU rendering actually engages.
    managed = _managed_runtime_python()
    if managed:
        _python_cache = managed
        return managed

    candidates: list[list[str]] = []
    if not getattr(sys, "frozen", False) and sys.executable:
        candidates.append([sys.executable])
    if os.name == "nt":
        candidates.extend([["py", "-3.12"], ["py", "-3.11"], ["py", "-3.10"], ["py", "-3"]])
    candidates.extend([["python"], ["python3"]])
    candidates.extend([[str(path)] for path in _candidate_paths()])

    for candidate in candidates:
        found = _probe_python(candidate)
        if found:
            _python_cache = found
            return found

    _python_cache = None
    return None

def _worker_error(returncode: int, stderr: str, stdout: str) -> str:
    """Extract a meaningful error from worker output.

    Filters out progress bars and library warnings (which otherwise dominate the
    tail and hide the real cause), and names native crashes explicitly.
    """
    # Windows access violation (e.g. loading SDXL weights into an SD1.5 pipeline).
    if returncode in (3221225477, -1073741819):
        return (
            "The model process crashed while loading this checkpoint (access violation). "
            "This usually means the checkpoint is an architecture the pipeline can't load. "
            "Try a different checkpoint, or report it."
        )
    text = (stderr or stdout or "").strip()
    noise = ("it/s", "s/it", "%|", "[transformers]", "Fetching ", "Loading pipeline")
    signal = [ln for ln in text.splitlines() if ln.strip() and not any(tok in ln for tok in noise)]
    detail = "\n".join(signal[-12:]) if signal else text[-1000:]
    return detail or f"diffusers worker failed with exit code {returncode}"


def _worker_env(python: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()

    # Managed runtime wins once installed. Otherwise a CPU-only system torch can
    # shadow the CUDA torch that LumenDeck installed into its app-local site dir.
    # Only use native torch by explicit opt-in.
    if _managed_runtime_matches(python):
        env["LUMENDECK_DIFFUSERS_SITE"] = str(_site_dir())
    elif os.environ.get("LUMENDECK_DIFFUSERS_USE_NATIVE", "").lower() in ("1", "true", "yes"):
        env.pop("LUMENDECK_DIFFUSERS_SITE", None)
    elif not _python_has_native_torch(python):
        env["LUMENDECK_DIFFUSERS_SITE"] = str(_site_dir())
    else:
        env.pop("LUMENDECK_DIFFUSERS_SITE", None)

    env["LUMENDECK_DIFFUSERS_MODEL"] = _MODEL_ID
    return env

def _worker(command: str, payload: dict[str, Any] | None = None, timeout: int = 1800) -> dict[str, Any]:
    python = _find_python()
    if not python:
        raise RuntimeError("No compatible Python 3.10-3.14 install was found. Install Python 3.12, then retry.")
    worker = _write_worker()
    env = _worker_env(python)
    proc = subprocess.run(
        python["cmd"] + [str(worker), command],
        input=json.dumps(payload or {}),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(_worker_error(proc.returncode, proc.stderr, proc.stdout))
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("diffusers worker returned no JSON")
    return json.loads(lines[-1])


_RESULT_MARKER = "@@LD_RESULT@@"


class _PersistentWorker:
    """A long-lived worker that keeps the model resident between renders.

    Requests/responses are newline-delimited JSON over stdin/stdout; results are
    prefixed with a marker so stray library stdout can't corrupt the stream.
    Dies automatically when the bridge closes its stdin (i.e. on app exit).
    """

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _spawn(self) -> None:
        python = _find_python()
        if not python:
            raise RuntimeError("No compatible Python 3.10-3.14 install was found. Install Python 3.12, then retry.")
        worker = _write_worker()
        log_path = _runtime_dir() / "worker.log"
        try:
            log = open(log_path, "ab", buffering=0)
        except OSError:
            log = subprocess.DEVNULL
        self._proc = subprocess.Popen(
            python["cmd"] + [str(worker), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=log,
            text=True,
            bufsize=1,
            env=_worker_env(python),
        )

    def request(self, command: str, payload: dict[str, Any], timeout: int = 1800) -> dict[str, Any]:
        with self._lock:
            if not self._alive():
                self._spawn()
            assert self._proc and self._proc.stdin and self._proc.stdout
            message = json.dumps({"command": command, "payload": payload}) + "\n"
            try:
                self._proc.stdin.write(message)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                self._spawn()
                assert self._proc and self._proc.stdin
                self._proc.stdin.write(message)
                self._proc.stdin.flush()
            while True:
                line = self._proc.stdout.readline()
                if line == "":
                    self._proc = None
                    raise RuntimeError("diffusers worker exited unexpectedly (see worker.log)")
                if line.startswith(_RESULT_MARKER):
                    return json.loads(line[len(_RESULT_MARKER):])

    def shutdown(self) -> None:
        with self._lock:
            if self._alive():
                assert self._proc
                try:
                    if self._proc.stdin:
                        self._proc.stdin.close()
                except Exception:
                    pass
                try:
                    self._proc.terminate()
                except Exception:
                    pass
            self._proc = None


_persistent_worker = _PersistentWorker()
atexit.register(_persistent_worker.shutdown)


def _pip_install(
    args: list[str],
    timeout: int = 1800,
    no_deps: bool = False,
    index_url: str | None = None,
    force_reinstall: bool = False,
) -> None:
    python = _find_python()
    if not python:
        raise RuntimeError("No compatible Python 3.10-3.13 install was found. Install Python 3.12, then retry.")
    _site_dir().mkdir(parents=True, exist_ok=True)
    cmd = python["cmd"] + ["-m", "pip", "install", "--upgrade", "--target", str(_site_dir())]
    if index_url:
        cmd += ["--index-url", index_url]
    if force_reinstall:
        cmd.append("--force-reinstall")
    if no_deps:
        cmd.append("--no-deps")
    cmd += args
    try:
        _run(cmd, timeout=timeout)
    except subprocess.CalledProcessError as exc:
        output = ((exc.stdout or "") + "\n" + (exc.stderr or "")).strip()
        raise RuntimeError(output[-1200:] or "pip install failed") from exc


def _decorate_status(status: dict[str, Any]) -> dict[str, Any]:
    python = _find_python()
    runtime = {
        "path": str(_runtime_dir()),
        "sitePackages": str(_site_dir()),
        "worker": str(_worker_path()),
        "exists": _site_dir().exists(),
        "installer": python,
        "torchTarget": _torch_target_label(),
        "torchIndexUrl": _torch_index_url(),
    }
    deps = status.setdefault("dependencies", {})
    deps["managedRuntime"] = runtime
    status["managedRuntime"] = runtime
    status["installable"] = python is not None
    return status


def model_status() -> dict[str, Any]:
    try:
        return _decorate_status(_worker("status", timeout=45))
    except Exception as exc:
        python = _find_python()
        return _decorate_status(
            {
                "modelId": _MODEL_ID,
                "dependenciesReady": False,
                "loaded": False,
                "modelCached": None,
                "device": "unknown",
                "cuda": False,
                "cacheDir": str(Path.home() / ".cache" / "huggingface"),
                "installCommand": _INSTALL_COMMAND,
                "message": str(exc) if python else "Install Python 3.12 so LumenDeck can create its managed Diffusers runtime.",
                "dependencies": {"ready": False},
            }
        )


def dependency_status() -> dict[str, Any]:
    return model_status()["dependencies"]


def is_available() -> bool:
    return bool(model_status().get("dependenciesReady"))


def install_runtime() -> dict[str, Any]:
    global _python_cache
    python = _find_python()
    if not python:
        raise RuntimeError("No compatible Python 3.10-3.13 install was found. Install Python 3.12, then retry.")

    _reset_site_dir()
    _pip_install(["torch"], index_url=_torch_index_url(), force_reinstall=True, timeout=2400)
    _pip_install(
        ["huggingface-hub", "filelock", "numpy==1.26.4", "packaging", "pillow", "pyyaml", "regex", "requests", "tqdm", "tokenizers==0.19.1", "safetensors"],
        timeout=1200,
    )
    _pip_install(["diffusers==0.30.3", "transformers==4.44.2", "accelerate", "kornia"], timeout=1200, no_deps=True)
    _write_python_manifest(python)
    _python_cache = python
    status = download_model()
    return {**status, "message": "Managed Diffusers runtime installed; SD-Turbo is ready for real photo renders."}


def download_model() -> dict[str, Any]:
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    return _decorate_status(_worker("download", timeout=1800))


def generate(job: dict) -> dict:
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    # Persistent worker: the model stays resident, so only the first render pays the
    # multi-GB load cost; later renders reuse it (reloading only on a model switch).
    try:
        out = _persistent_worker.request("generate", job, timeout=1800)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("generate", job, timeout=1800)
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(out["error"])
    return out
