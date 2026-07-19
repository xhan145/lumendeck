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
import struct
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

# ControlNet capability map: family -> control type -> Hugging Face repo.
# Single source of truth. The worker never duplicates this table: generate()/
# preprocess() pass it inside each job (job["controlnetMap"]) and the worker
# indexes it by the family it detects from the loaded UNet at render time.
# Mirrored in src/core/controlnet.ts so frontend health checks stay fetch-free.
CONTROLNET_MODELS: dict[str, dict[str, str]] = {
    "SD1.5": {
        "canny": "lllyasviel/control_v11p_sd15_canny",
        "depth": "lllyasviel/control_v11f1p_sd15_depth",
        "pose": "lllyasviel/control_v11p_sd15_openpose",
        "scribble": "lllyasviel/control_v11p_sd15_scribble",
        "lineart": "lllyasviel/control_v11p_sd15_lineart",
        "softedge": "lllyasviel/control_v11p_sd15_softedge",
        "tile": "lllyasviel/control_v11f1e_sd15_tile",
    },
    "SD2.1": {
        "canny": "thibaud/controlnet-sd21-canny-diffusers",
        "depth": "thibaud/controlnet-sd21-depth-diffusers",
        "pose": "thibaud/controlnet-sd21-openpose-diffusers",
    },
    "SDXL": {
        "canny": "diffusers/controlnet-canny-sdxl-1.0",
        "depth": "diffusers/controlnet-depth-sdxl-1.0",
        "pose": "thibaud/controlnet-openpose-sdxl-1.0",
        "scribble": "xinsir/controlnet-scribble-sdxl-1.0",
        "tile": "xinsir/controlnet-tile-sdxl-1.0",
    },
}

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


# --- GTX 1650 4GB low-VRAM helpers (worker copy; module mirror in the outer
# file: detect_hardware / worker_dtype_name / is_cuda_oom / release_gpu_refs). ---
_CUDA_OOM_SIGNATURES = (
    "cuda out of memory", "out of memory", "outofmemoryerror",
    "cublas_status_alloc_failed", "hip out of memory",
)


def is_cuda_oom(err):
    text = str(err).lower()
    return any(sig in text for sig in _CUDA_OOM_SIGNATURES)


def worker_dtype(mem, torch):
    """torch dtype for the load: legacy float16-on-CUDA unless mem overrides it."""
    try:
        cuda = bool(torch.cuda.is_available())
    except Exception:
        cuda = False
    if not cuda:
        return torch.float32
    prec = str((mem or {}).get("precision", "")).lower()
    if prec == "fp32":
        return torch.float32
    if prec == "bf16":
        supported = False
        try:
            supported = bool(torch.cuda.is_bf16_supported())
        except Exception:
            supported = False
        return torch.bfloat16 if supported else torch.float16
    return torch.float16


def detect_hardware(torch):
    info = {"cuda": False, "cudaInitFailed": False, "gpuName": None,
            "totalVramMb": None, "freeVramMb": None, "computeCapability": None,
            "bf16Supported": False}
    try:
        cuda = bool(torch.cuda.is_available())
    except Exception:
        info["cudaInitFailed"] = True
        return info
    info["cuda"] = cuda
    if not cuda:
        return info
    try:
        props = torch.cuda.get_device_properties(0)
        info["gpuName"] = getattr(props, "name", None)
        total = getattr(props, "total_memory", None)
        if total:
            info["totalVramMb"] = int(total) // (1024 * 1024)
        major = getattr(props, "major", None)
        minor = getattr(props, "minor", None)
        if major is not None and minor is not None:
            info["computeCapability"] = "{}.{}".format(major, minor)
    except Exception:
        info["cudaInitFailed"] = True
    try:
        free, _total = torch.cuda.mem_get_info()
        info["freeVramMb"] = int(free) // (1024 * 1024)
    except Exception:
        pass
    try:
        info["bf16Supported"] = bool(torch.cuda.is_bf16_supported())
    except Exception:
        info["bf16Supported"] = False
    return info


def release_gpu_refs(state):
    for key in ("pipe", "anim_pipe", "svd_pipe"):
        state[key] = None
    for key in ("key", "anim_key", "svd_key", "lora_key"):
        state[key] = None
    state["controlnets"] = {}
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def status(message=None, loaded=False):
    torch_info = module_info("torch")
    diffusers_info = module_info("diffusers")
    torch = torch_info.pop("module", None)
    diffusers_info.pop("module", None)
    ready = bool(torch_info.get("importable") and diffusers_info.get("importable"))
    device = "unknown"
    cuda = False
    hardware = {}
    if torch is not None:
        hardware = detect_hardware(torch)
        cuda = bool(hardware.get("cuda"))
        if hardware.get("cudaInitFailed"):
            device = "unknown"
        else:
            device = "cuda" if cuda else "cpu"
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
        # Best-effort hardware detection for the hardware-profile system. All
        # optional — a detection failure leaves them null and never blocks launch.
        "gpuName": hardware.get("gpuName"),
        "totalVramMb": hardware.get("totalVramMb"),
        "freeVramMb": hardware.get("freeVramMb"),
        "computeCapability": hardware.get("computeCapability"),
        "cudaInitFailed": bool(hardware.get("cudaInitFailed")),
        "bf16Supported": bool(hardware.get("bf16Supported")),
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


def load_pipe(model_ref=None, mem=None):
    """Load a text2img pipe. `mem` is the optional low-VRAM directive from the
    active hardware profile. When mem['lowVram'] is set (GTX 1650 4GB profile /
    safe retry) the pipe is loaded with the requested precision and CPU offload
    instead of a whole-pipe .to('cuda'), so it fits a 4 GB card. Without a
    low-VRAM directive the path is the unchanged legacy one (byte-for-byte)."""
    import torch
    mem = mem or {}
    low_vram = bool(mem.get("lowVram"))
    dtype = worker_dtype(mem, torch) if low_vram else (torch.float16 if torch.cuda.is_available() else torch.float32)
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
    if low_vram and torch.cuda.is_available():
        # Low-VRAM path: keep only the active submodule resident. Enable the
        # requested memory optimizations, then offload — NEVER .to('cuda') after
        # offload (diffusers manages device placement dynamically once offloaded).
        _apply_slicing(pipe, mem)
        try:
            if mem.get("sequentialCpuOffload"):
                pipe.enable_sequential_cpu_offload()
            elif mem.get("modelCpuOffload", True):
                pipe.enable_model_cpu_offload()
            else:
                pipe = pipe.to("cuda")
        except Exception:
            # Offload not supported by this pipe — fall back to resident + slicing.
            pipe = pipe.to("cuda")
    else:
        # Legacy path (unchanged): resident on the compute device + always slice.
        pipe = pipe.to("cuda" if torch.cuda.is_available() else "cpu")
        for enable in ("enable_attention_slicing", "enable_vae_slicing", "enable_vae_tiling"):
            try:
                getattr(pipe, enable)()
            except Exception:
                pass
    return pipe


def _apply_slicing(pipe, mem):
    """Enable the memory optimizations the directive requests (best-effort)."""
    wanted = []
    if mem.get("attentionSlicing", True):
        wanted.append("enable_attention_slicing")
    if mem.get("vaeSlicing", True):
        wanted.append("enable_vae_slicing")
    if mem.get("vaeTiling", True):
        wanted.append("enable_vae_tiling")
    for enable in wanted:
        try:
            getattr(pipe, enable)()
        except Exception:
            pass


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
        # Free the still-image pipe (and any old animate/SVD pipe) to conserve VRAM.
        state["pipe"] = None
        state["key"] = None
        state["controlnets"] = {}
        state["anim_pipe"] = None
        state["svd_pipe"] = None
        state["svd_key"] = None
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


def _svd_target_size(width, height):
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        return (1024, 576)
    if w <= 0 or h <= 0:
        return (1024, 576)
    return (576, 1024) if h > w else (1024, 576)


def _clamp_svd(job):
    def _i(key, default, lo, hi):
        try:
            v = int(job.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))
    try:
        naug = float(job.get("noise_aug_strength", 0.02))
    except (TypeError, ValueError):
        naug = 0.02
    return {
        "num_frames": _i("num_frames", 14, 8, 25),
        "fps": _i("fps", 7, 1, 30),
        "motion_bucket_id": _i("motion_bucket_id", 127, 1, 255),
        "noise_aug_strength": max(0.0, min(1.0, naug)),
        "decode_chunk_size": _i("decode_chunk_size", 2, 1, 8),
        "num_inference_steps": _i("num_inference_steps", 25, 1, 50),
        "seed": _i("seed", 0, 0, 2**31 - 1),
    }


def _load_svd_pipe(model_path):
    import torch
    from diffusers import StableVideoDiffusionPipeline
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    if os.path.isdir(model_path):
        try:
            pipe = StableVideoDiffusionPipeline.from_pretrained(model_path, torch_dtype=dtype, variant="fp16")
        except Exception:
            pipe = StableVideoDiffusionPipeline.from_pretrained(model_path, torch_dtype=dtype)
    else:
        pipe = StableVideoDiffusionPipeline.from_single_file(model_path, torch_dtype=dtype)
    for enable in ("enable_vae_slicing", "enable_vae_tiling", "enable_attention_slicing"):
        try:
            getattr(pipe, enable)()
        except Exception:
            pass
    if torch.cuda.is_available():
        try:
            pipe.enable_model_cpu_offload()
        except Exception:
            pipe = pipe.to("cuda")
    else:
        pipe = pipe.to("cpu")
    return pipe


def _animate_svd(job, state, report):
    """Real image->video via Stable Video Diffusion, encoded H.264. Loud on OOM/missing."""
    import base64 as _b64
    import io as _io
    import torch
    from PIL import Image
    model_path = job.get("modelPath")
    if not model_path or not os.path.exists(model_path):
        raise RuntimeError("No SVD model found. Put a Stable Video Diffusion model in your models folder.")
    key = "svd:" + str(model_path)
    if state.get("svd_key") != key or state.get("svd_pipe") is None:
        report({"phase": "loading"})
        state["pipe"] = None
        state["key"] = None
        state["anim_pipe"] = None
        state["anim_key"] = None
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        state["svd_pipe"] = _load_svd_pipe(model_path)
        state["svd_key"] = key
    pipe = state["svd_pipe"]

    raw = job.get("image", "")
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        image = Image.open(_io.BytesIO(_b64.b64decode(raw))).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"Could not decode the input image: {exc}")
    tw, th = _svd_target_size(image.width, image.height)
    src_ar, dst_ar = image.width / image.height, tw / th
    if src_ar > dst_ar:
        nw = int(image.height * dst_ar)
        left = (image.width - nw) // 2
        image = image.crop((left, 0, left + nw, image.height))
    else:
        nh = int(image.width / dst_ar)
        top = (image.height - nh) // 2
        image = image.crop((0, top, image.width, top + nh))
    image = image.resize((tw, th))

    p = _clamp_svd(job)
    gen_device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = torch.Generator(device=gen_device).manual_seed(p["seed"])
    # Progress is per DENOISING step (num_inference_steps), not per output frame.
    steps = p["num_inference_steps"]
    report({"phase": "rendering", "step": 0, "steps": steps})

    def on_step(_pipe, step, _timestep, callback_kwargs):
        report({"phase": "rendering", "step": int(step) + 1, "steps": steps})
        return callback_kwargs

    kwargs = dict(
        image=image,
        # Pass the cropped target size so the OUTPUT orientation matches the still —
        # SVD defaults to 1024x576 and would otherwise stretch portrait inputs to landscape.
        height=th,
        width=tw,
        num_frames=p["num_frames"],
        num_inference_steps=steps,
        motion_bucket_id=p["motion_bucket_id"],
        noise_aug_strength=p["noise_aug_strength"],
        decode_chunk_size=p["decode_chunk_size"],
        generator=generator,
    )
    try:
        try:
            result = pipe(**kwargs, callback_on_step_end=on_step)
        except TypeError:
            result = pipe(**kwargs)
    except torch.cuda.OutOfMemoryError:
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        state["svd_pipe"] = None
        state["svd_key"] = None
        raise RuntimeError("Not enough VRAM for SVD at these settings - try fewer frames or a smaller decode chunk.")
    frames = result.frames[0]
    report({"phase": "decoding"})
    encoded = _encode_sequence([f.convert("RGB") for f in frames], p["fps"], "mp4", loop=False)
    report({"phase": "done"})
    return {**encoded, "seed": p["seed"], "frameCount": len(frames), "fps": p["fps"], "engine": "svd"}


_CONTROL_TYPES = ("canny", "depth", "pose", "scribble", "lineart", "softedge", "tile")
_DETECTOR_CACHE = {}


def normalize_controls(job):
    """Stacked list (controlNets) plus legacy single entry (controlNet) -> one list.

    Only entries that actually carry a control image count. When both keys are
    present the list wins: the frontend mirrors its first slot into controlNet
    purely for old-sidecar compatibility, so honoring both would double-apply it."""
    controls = job.get("controlNets") or ([job["controlNet"]] if job.get("controlNet") else [])
    return [c for c in controls if isinstance(c, dict) and c.get("image")]


def _aux_detector(kind):
    """Load (and cache) a controlnet_aux detector, with a clear error if the
    package is missing. canny/tile never come through here."""
    if kind in _DETECTOR_CACHE:
        return _DETECTOR_CACHE[kind]
    try:
        import controlnet_aux
    except Exception as exc:
        raise RuntimeError(
            f"{kind} preprocessing needs the controlnet_aux package. "
            f"Reinstall the runtime (Install runtime + model) to add it. ({exc})"
        )
    loaders = {
        "depth": lambda: controlnet_aux.MidasDetector.from_pretrained("lllyasviel/Annotators"),
        "pose": lambda: controlnet_aux.OpenposeDetector.from_pretrained("lllyasviel/Annotators"),
        "scribble": lambda: controlnet_aux.HEDdetector.from_pretrained("lllyasviel/Annotators"),
        "lineart": lambda: controlnet_aux.LineartDetector.from_pretrained("lllyasviel/Annotators"),
        "softedge": lambda: controlnet_aux.PidiNetDetector.from_pretrained("lllyasviel/Annotators"),
    }
    if kind not in loaders:
        raise RuntimeError(f"unknown control type: {kind}")
    try:
        detector = loaders[kind]()
    except Exception as exc:
        raise RuntimeError(f"loading the {kind} preprocessor (controlnet_aux) failed: {exc}")
    _DETECTOR_CACHE[kind] = detector
    return detector


def preprocess_control(kind, image, width, height):
    """Turn a source image into the control map for `kind`, sized (width, height).

    canny and tile must never require controlnet_aux: tile is a passthrough
    resize, and canny falls back to cv2.Canny, then PIL edge filtering."""
    from PIL import Image
    kind = str(kind or "canny").lower()
    rgb = image.convert("RGB")
    if kind == "tile":
        return rgb.resize((width, height))
    if kind == "canny":
        detector = _DETECTOR_CACHE.get("canny")
        if detector is None:
            try:
                from controlnet_aux import CannyDetector
                detector = CannyDetector()
                _DETECTOR_CACHE["canny"] = detector
            except Exception:
                detector = None
        if detector is not None:
            out = detector(rgb)
        else:
            try:
                import numpy
                import cv2
                out = Image.fromarray(cv2.Canny(numpy.array(rgb), 100, 200))
            except Exception as exc:
                from PIL import ImageFilter
                print(f"[controlnet] canny via PIL edge fallback ({exc})", file=sys.stderr, flush=True)
                out = rgb.convert("L").filter(ImageFilter.FIND_EDGES)
        return out.convert("RGB").resize((width, height))
    if kind not in _CONTROL_TYPES:
        raise RuntimeError(
            f"unknown control type: {kind} (expected one of {', '.join(_CONTROL_TYPES)})"
        )
    detector = _aux_detector(kind)
    if kind == "scribble":
        out = detector(rgb, scribble=True)
    else:
        out = detector(rgb)
    return out.convert("RGB").resize((width, height))


def do_preprocess(job):
    """Extract a control map on demand (the rack's Preview button, no render)."""
    image_b64 = job.get("image")
    if not image_b64:
        raise RuntimeError("preprocess needs an 'image' (base64 or data URL)")
    from PIL import Image
    raw = base64.b64decode(str(image_b64).split(",")[-1])
    src = Image.open(io.BytesIO(raw))
    width = int(job.get("width") or src.width)
    height = int(job.get("height") or src.height)
    out = preprocess_control(job.get("type"), src, width, height)
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return {"map_base64": base64.b64encode(buf.getvalue()).decode("ascii")}


def _render_one_image(job, state, report):
    """Render one PIL image from `job`, reusing state['pipe'] when the model matches.

    Extracted from do_generate so the render_sequence op (motion render) can drive
    the SAME text2img/img2img/inpaint/ControlNet/hires code per frame with the model
    resident across frames. Returns (image, seed, dropped). Does NOT encode or write
    the terminal 'done' progress — the caller owns that so do_generate's byte-for-byte
    output and single-image progress protocol are unchanged.
    """
    import torch
    model_ref = job.get("modelRef") or {"kind": "hub", "id": MODEL_ID}
    # Fold the low-VRAM signature into the cache key so switching into/out of the
    # offload path (or the safe retry escalating to sequential offload) forces a
    # reload with the correct device placement. Without a low-VRAM directive the
    # key is IDENTICAL to before (legacy users: byte-for-byte same cache behavior).
    _mem = job.get("memoryProfile") or {}
    _mem_key = ""
    if _mem.get("lowVram"):
        _mem_key = "|lv:{}:{}".format(
            _mem.get("precision", "fp16"),
            "seq" if _mem.get("sequentialCpuOffload") else "model",
        )
    key = _ref_key(model_ref) + _mem_key
    if state.get("key") != key or state.get("pipe") is None:
        report({"phase": "loading"})
        if state.get("pipe") is not None:
            state["pipe"] = None
            state["lora_key"] = None
            state["controlnets"] = {}
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        # Switching back to still renders from SVD: evict the resident SVD pipe too
        # (it holds several GB and would otherwise leak on an 8GB card).
        if state.get("svd_pipe") is not None:
            state["svd_pipe"] = None
            state["svd_key"] = None
            try:
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        state["pipe"] = load_pipe(model_ref, job.get("memoryProfile"))
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
    controls = normalize_controls(job)
    init_b64 = job.get("initImage")
    mask_b64 = job.get("maskImage")

    dropped = []
    cn_models, cn_images, cn_scales = [], [], []
    is_xl = False
    if controls:
        # ControlNet: structural guidance from per-slot control images. Detect the
        # family from the loaded UNet's cross-attention dim (768=SD1.5, 1024=SD2.1,
        # 2048=SDXL) so the picked ControlNets always match the checkpoint. Types
        # the family can't do are dropped (returned loudly), never fatal.
        from PIL import Image
        try:
            cross_dim = int(pipe.unet.config.cross_attention_dim)
        except Exception:
            cross_dim = 768
        if cross_dim >= 2048:
            cn_family, is_xl = "SDXL", True
        elif cross_dim >= 1024:
            cn_family, is_xl = "SD2.1", False
        else:
            cn_family, is_xl = "SD1.5", False
        cn_map = (job.get("controlnetMap") or {}).get(cn_family) or {}
        cn_cache = state.setdefault("controlnets", {})
        cn_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        for control in controls:
            cn_type = str(control.get("model") or "canny").lower()
            cn_id = cn_map.get(cn_type)
            if not cn_id:
                dropped.append({
                    "type": cn_type,
                    "reason": f"no {cn_type} ControlNet is available for {cn_family} checkpoints",
                })
                continue
            raw = base64.b64decode(str(control["image"]).split(",")[-1])
            ctrl_img = preprocess_control(cn_type, Image.open(io.BytesIO(raw)), width, height)
            cache_key = cn_family + ":" + cn_type
            if cache_key not in cn_cache:
                from diffusers import ControlNetModel
                cn_cache[cache_key] = ControlNetModel.from_pretrained(cn_id, torch_dtype=cn_dtype)
            cn_models.append(cn_cache[cache_key])
            cn_images.append(ctrl_img)
            cn_scales.append(float(control.get("strength", 1.0)))

    if cn_models:
        if is_xl:
            from diffusers import StableDiffusionXLControlNetPipeline as CNPipe
        else:
            from diffusers import StableDiffusionControlNetPipeline as CNPipe
        # One control -> a single ControlNetModel; several -> pass the list so
        # diffusers forms a MultiControlNet (images/scales become lists too).
        one = len(cn_models) == 1
        cnp = CNPipe.from_pipe(pipe, controlnet=cn_models[0] if one else cn_models)
        try:
            cnp.enable_model_cpu_offload()
        except Exception:
            pass
        cn_call = dict(
            prompt=str(job.get("prompt", "")),
            negative_prompt=str(job.get("negativePrompt", "")) or None,
            image=cn_images[0] if one else cn_images,
            controlnet_conditioning_scale=cn_scales[0] if one else cn_scales,
            num_inference_steps=steps,
            guidance_scale=guidance,
            generator=generator,
        )
        try:
            image = cnp(**cn_call, callback_on_step_end=on_step).images[0]
        except TypeError:
            image = cnp(**cn_call).images[0]
    elif init_b64:
        # img2img / inpaint: reuse the loaded checkpoint's weights via from_pipe
        # (no reload), just a different pipeline class.
        from PIL import Image
        is_xl = _model_family(model_ref) == "SDXL"

        def _decode(b64):
            raw = base64.b64decode(str(b64).split(",")[-1])
            return Image.open(io.BytesIO(raw)).convert("RGB").resize((width, height))

        init_img = _decode(init_b64)
        strength = max(0.05, min(1.0, float(job.get("denoiseStrength", 0.6))))
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

    # Hires fix: optional second img2img pass at a larger size for sharper detail.
    hires_scale = float(job.get("hiresScale", 1) or 1)
    if hires_scale > 1.01:
        from diffusers import StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline
        is_xl = _model_family(model_ref) == "SDXL"
        HCls = StableDiffusionXLImg2ImgPipeline if is_xl else StableDiffusionImg2ImgPipeline
        hp = HCls.from_pipe(pipe)
        up = image.resize((int(width * hires_scale), int(height * hires_scale)))
        image = hp(
            prompt=str(job.get("prompt", "")),
            negative_prompt=str(job.get("negativePrompt", "")) or None,
            image=up,
            strength=max(0.05, min(1.0, float(job.get("hiresDenoise", 0.35)))),
            num_inference_steps=max(1, min(60, int(job.get("hiresSteps", 14)))),
            guidance_scale=guidance,
            generator=generator,
        ).images[0]

    report({"phase": "done", "step": steps, "steps": steps})
    return image, seed, dropped


def _job_reporter(job):
    """Build a progress reporter that writes to job['progressPath'] (or a no-op)."""
    progress_path = job.get("progressPath")

    def report(data):
        if not progress_path:
            return
        try:
            with open(progress_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        except OSError:
            pass

    return report


def do_generate(job, state):
    """Render one image, reusing state['pipe'] when the model hasn't changed.

    `state` persists across calls in serve mode, so the (multi-GB) model loads once
    and only reloads when you switch checkpoints. In one-shot mode it's a fresh dict.
    """
    import torch
    report = _job_reporter(job)

    if str(job.get("output", "image")) == "video":
        return _animate(job, state, report)

    try:
        image, seed, dropped = _render_one_image(job, state, report)
    except Exception as exc:
        # OOM anywhere in the still path (load / sampling / VAE decode): dispose
        # partially-loaded resources, release CUDA cache, and return a CATEGORIZED
        # error so the UI can offer a single safe retry. Unrelated errors are
        # re-raised untouched (never swallowed as OOM).
        if isinstance(exc, getattr(torch.cuda, "OutOfMemoryError", tuple())) or is_cuda_oom(exc):
            release_gpu_refs(state)
            report({"phase": "error"})
            return {
                "error": "CUDA out of memory: the render exceeded the GPU memory budget. {}".format(exc),
                "errorCategory": "cuda_oom",
            }
        raise

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    result = {"image_base64": base64.b64encode(buf.getvalue()).decode("ascii"), "seed": seed}
    if dropped:
        result["droppedControls"] = dropped
    return result


def _encode_sequence(frames, fps, fmt, loop=True):
    """Encode a list of PIL RGB frames into a base64 video.

    Kept behaviorally identical to the module-level diffusers_backend._encode_sequence
    (which is the unit-tested copy); this in-worker copy is what actually runs.
    format 'mp4' (default): H.264/avc1 via imageio + imageio-ffmpeg's bundled libx264
    (pixelformat yuv420p, +faststart). WebView2/Chromium's <video> can ONLY decode
    H.264/VP8/VP9/AV1, NOT the MPEG-4 Part 2 'mp4v' that cv2.VideoWriter produced
    (which loaded as a black player). If the ffmpeg encoder is unavailable OR fails,
    fall back to GIF. format 'gif' (or the mp4 fallback): the proven AnimateDiff
    Pillow save_all path. Returns {video_base64, mediaType, mimeType, extension}.
    Never silent — the caller surfaces which path ran.
    """
    fmt = str(fmt or "mp4").lower()
    if not frames:
        raise RuntimeError("cannot encode a video with zero frames")
    fps = max(1, min(30, int(fps or 8)))

    # All frames must share one canvas. A motion clip can animate a size-affecting
    # param (canvas width/height, hires scale) -> frames of differing dimensions.
    # A video encoder silently DROPS mismatched frames and GIF assembly corrupts,
    # so conform every frame to the first frame's size: a valid uniform video, never
    # a silent truncation (spec: no silent placeholders).
    base_size = frames[0].size
    frames = [f if f.size == base_size else f.resize(base_size) for f in frames]

    if fmt == "mp4":
        try:
            import tempfile as _tempfile

            import imageio.v2 as _imageio
            import numpy as np

            width, height = frames[0].size
            # yuv420p (the browser-safe H.264 chroma format) requires EVEN width and
            # height. Pad by edge-replication rather than crop (never a silent
            # truncation). macro_block_size=1 stops imageio's own /16 auto-resize.
            pad_w = width + (width % 2)
            pad_h = height + (height % 2)
            arrays = []
            for frame in frames:
                arr = np.asarray(frame.convert("RGB"))
                if pad_h != height or pad_w != width:
                    arr = np.pad(arr, ((0, pad_h - height), (0, pad_w - width), (0, 0)), mode="edge")
                arrays.append(arr)
            tmp = _tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
            tmp_path = tmp.name
            tmp.close()
            try:
                writer = _imageio.get_writer(
                    tmp_path, format="FFMPEG", mode="I", fps=float(fps),
                    codec="libx264", pixelformat="yuv420p", macro_block_size=1,
                    ffmpeg_params=["-movflags", "+faststart", "-preset", "veryfast"],
                )
                try:
                    for arr in arrays:
                        writer.append_data(arr)
                finally:
                    writer.close()
                with open(tmp_path, "rb") as fh:
                    data = fh.read()
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if not data:
                raise RuntimeError("ffmpeg produced an empty mp4")
            return {
                "video_base64": base64.b64encode(data).decode("ascii"),
                "mediaType": "video",
                "mimeType": "video/mp4",
                "extension": "mp4",
            }
        except Exception as exc:
            print(f"[render_sequence] h264 mp4 encode failed, falling back to gif: {exc}", file=sys.stderr, flush=True)

    if fmt == "webm":
        try:
            import tempfile as _tempfile

            import imageio.v2 as _imageio
            import numpy as np

            width, height = frames[0].size
            pad_w = width + (width % 2)
            pad_h = height + (height % 2)
            arrays = []
            for frame in frames:
                arr = np.asarray(frame.convert("RGB"))
                if pad_h != height or pad_w != width:
                    arr = np.pad(arr, ((0, pad_h - height), (0, pad_w - width), (0, 0)), mode="edge")
                arrays.append(arr)
            tmp = _tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
            tmp_path = tmp.name
            tmp.close()
            try:
                writer = _imageio.get_writer(
                    tmp_path, format="FFMPEG", mode="I", fps=float(fps),
                    codec="libvpx-vp9", pixelformat="yuv420p", macro_block_size=1,
                    ffmpeg_params=["-b:v", "0", "-crf", "32", "-movflags", "+faststart"],
                )
                try:
                    for arr in arrays:
                        writer.append_data(arr)
                finally:
                    writer.close()
                with open(tmp_path, "rb") as fh:
                    data = fh.read()
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if not data:
                raise RuntimeError("ffmpeg produced an empty webm")
            return {
                "video_base64": base64.b64encode(data).decode("ascii"),
                "mediaType": "video",
                "mimeType": "video/webm",
                "extension": "webm",
            }
        except Exception as exc:
            print(f"[render_sequence] vp9 webm encode failed, falling back to gif: {exc}", file=sys.stderr, flush=True)

    if fmt == "frames":
        # A frame-sequence export: a ZIP of numbered PNGs, built with the stdlib
        # (no ffmpeg). Not gallery media — the caller downloads it as an archive.
        import zipfile as _zip

        zbuf = io.BytesIO()
        with _zip.ZipFile(zbuf, "w", _zip.ZIP_DEFLATED) as zf:
            for index, frame in enumerate(frames):
                fbuf = io.BytesIO()
                frame.convert("RGB").save(fbuf, format="PNG")
                zf.writestr("frame_%04d.png" % (index + 1), fbuf.getvalue())
        return {
            "video_base64": base64.b64encode(zbuf.getvalue()).decode("ascii"),
            "mediaType": "archive",
            "mimeType": "application/zip",
            "extension": "zip",
        }

    # GIF path (explicit request, or mp4/webm fallback): AnimateDiff's proven save_all loop.
    buf = io.BytesIO()
    frames[0].save(
        buf, format="GIF", save_all=True, append_images=frames[1:],
        duration=int(1000 / fps), loop=0 if loop else 1, disposal=2,
    )
    return {
        "video_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "mediaType": "video",
        "mimeType": "image/gif",
        "extension": "gif",
    }


def do_render_sequence(payload, state):
    """Render a motion clip: loop each job through the resident single-image pipe.

    The model/pipe stays loaded across frames (the whole point of the persistent
    worker) — only the per-frame job params vary. Collects PIL frames, writing
    {phase:'frame', step:i, steps:N} to the shared progress file after each, then
    encodes an mp4 (cv2) or gif (Pillow) and returns the video result.
    """
    jobs = payload.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("render_sequence needs a non-empty 'jobs' list")
    total = max(1, min(120, len(jobs)))
    jobs = jobs[:total]
    fps = int(payload.get("fps", 8))
    fmt = str(payload.get("format", "mp4")).lower()
    progress_path = payload.get("progressPath")

    def report(data):
        if not progress_path:
            return
        try:
            with open(progress_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        except OSError:
            pass

    frames = []
    seed = None
    for index, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise RuntimeError(f"render_sequence job {index} is not an object")
        # Per-frame progress writes to the shared clip file, not each job's own path.
        job = dict(job)
        job.pop("progressPath", None)
        image, frame_seed, _dropped = _render_one_image(job, state, lambda _data: None)
        frames.append(image.convert("RGB"))
        if seed is None:
            seed = frame_seed
        report({"phase": "frame", "step": index + 1, "steps": total})

    loop = bool(jobs[0].get("loop", True))
    encoded = _encode_sequence(frames, fps, fmt, loop=loop)
    report({"phase": "done"})
    return {**encoded, "seed": seed if seed is not None else 0, "frameCount": len(frames), "fps": max(1, min(30, fps))}


# --- Auto-evolve scoring (Living Constellation Phase 4) ----------------------
# Behaviorally identical to bridge/scorer.py (the unit-tested reference); this
# in-worker copy is what actually runs, with torch/transformers/numpy resident.
# CLIP is cached module-global so a whole population/run loads it once; a failure
# latches so it degrades to aesthetics-only instantly (never a fabricated number).
_CLIP = {"model": None, "processor": None, "failed": False, "reason": None}


def _clamp01(value):
    return max(0.0, min(1.0, float(value)))


def _load_clip():
    if _CLIP["failed"]:
        return None, None
    if _CLIP["model"] is not None:
        return _CLIP["model"], _CLIP["processor"]
    try:
        import torch  # noqa: F401
        from transformers import CLIPModel, CLIPProcessor
        model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        model.eval()
        _CLIP["model"] = model
        _CLIP["processor"] = processor
        return model, processor
    except Exception as exc:
        _CLIP["failed"] = True
        _CLIP["reason"] = f"CLIP is unavailable ({exc}); scoring on aesthetic heuristics only."
        return None, None


def _clip_scores(images, prompt):
    model, processor = _load_clip()
    if model is None:
        return None, _CLIP.get("reason")
    import torch
    with torch.no_grad():
        inputs = processor(text=[prompt or ""], images=list(images), return_tensors="pt", padding=True)
        # Full forward -> projected embeds (stable across transformers versions;
        # get_image_features/get_text_features changed return type in 5.x).
        outputs = model(**inputs)
        image_features = outputs.image_embeds
        text_features = outputs.text_embeds
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        cos = (image_features @ text_features.T).squeeze(-1)
        values = [_clamp01((float(c) + 1.0) / 2.0) for c in cos.reshape(-1)]
    return values, None


def _aesthetic_metrics(image):
    import math
    import numpy as np
    arr = np.asarray(image.convert("RGB"), dtype=np.float64)
    red, green, blue = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    luma = 0.299 * red + 0.587 * green + 0.114 * blue
    if luma.shape[0] >= 3 and luma.shape[1] >= 3:
        laplacian = (-4.0 * luma[1:-1, 1:-1] + luma[:-2, 1:-1] + luma[2:, 1:-1] + luma[1:-1, :-2] + luma[1:-1, 2:])
        sharp_raw = float(laplacian.var())
    else:
        sharp_raw = 0.0
    sharpness = 1.0 - math.exp(-sharp_raw / 500.0)
    contrast = _clamp01(float(luma.std()) / 80.0)
    rg = red - green
    yb = 0.5 * (red + green) - blue
    std_root = math.sqrt(float(rg.std()) ** 2 + float(yb.std()) ** 2)
    mean_root = math.sqrt(float(rg.mean()) ** 2 + float(yb.mean()) ** 2)
    colorfulness = _clamp01((std_root + 0.3 * mean_root) / 110.0)
    hist, _edges = np.histogram(luma, bins=256, range=(0.0, 255.0))
    total = float(hist.sum())
    if total > 0.0:
        probs = hist.astype(np.float64) / total
        nonzero = probs[probs > 0.0]
        entropy = float(-(nonzero * np.log2(nonzero)).sum())
    else:
        entropy = 0.0
    entropy_norm = _clamp01(entropy / 8.0)
    aesthetic = (sharpness + contrast + colorfulness + entropy_norm) / 4.0
    return {
        "sharpness": _clamp01(sharpness),
        "contrast": contrast,
        "colorfulness": colorfulness,
        "entropy": entropy_norm,
        "aesthetic": _clamp01(aesthetic),
    }


def _blend(clip_value, aesthetic_value, weights, clip_available):
    weights = weights or {}
    clip_weight = max(0.0, float(weights.get("clip", 0.5)))
    aesthetic_weight = max(0.0, float(weights.get("aesthetic", 0.5)))
    if not clip_available or clip_value is None:
        return _clamp01(aesthetic_value)
    total = clip_weight + aesthetic_weight
    if total <= 0.0:
        return _clamp01((clip_value + aesthetic_value) / 2.0)
    return _clamp01((clip_weight * clip_value + aesthetic_weight * aesthetic_value) / total)


def _score_images(images, prompt, weights):
    weights = weights or {}
    images = list(images)
    aesthetics = [_aesthetic_metrics(image) for image in images]
    clip_values, clip_reason = _clip_scores(images, prompt)
    clip_available = clip_values is not None
    results = []
    for index, metrics in enumerate(aesthetics):
        clip_value = clip_values[index] if clip_available else None
        score = _blend(clip_value, metrics["aesthetic"], weights, clip_available)
        results.append({"score": score, "clip": clip_value, "aesthetic": metrics["aesthetic"]})
    return results, clip_available, (None if clip_available else clip_reason)


def do_evolve_step(payload, state):
    """Render a candidate population (model resident) then score each candidate.

    payload: {"jobs": [RenderJob...], "prompt": str, "weights": {"clip","aesthetic"},
              "progressPath"?: str}. Renders each job through the SAME resident pipe
    (one model load for the whole population), writes {phase:'candidate', step:i,
    steps:N} per candidate, then scores them with the CLIP+aesthetic scorer. Returns
    {"candidates":[{image_base64, score, breakdown:{clip,aesthetic}, index}],
     "clipAvailable": bool, "fallbackReason"?: str}. Loud on bad input; never silent.
    """
    jobs = payload.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("evolve_step needs a non-empty 'jobs' list")
    total = max(1, min(8, len(jobs)))
    jobs = jobs[:total]
    prompt = str(payload.get("prompt", ""))
    weights = payload.get("weights") or {}
    progress_path = payload.get("progressPath")

    def report(data):
        if not progress_path:
            return
        try:
            with open(progress_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        except OSError:
            pass

    frames = []
    encoded = []
    for index, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise RuntimeError(f"evolve_step job {index} is not an object")
        report({"phase": "candidate", "step": index, "steps": total})
        # Per-candidate internal steps are suppressed; candidate-level progress is
        # what the UI polls (like render_sequence's per-frame progress).
        job = dict(job)
        job.pop("progressPath", None)
        image, _seed, _dropped = _render_one_image(job, state, lambda _data: None)
        frames.append(image.convert("RGB"))
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        encoded.append(base64.b64encode(buf.getvalue()).decode("ascii"))

    report({"phase": "scoring", "step": total, "steps": total})
    results, clip_available, clip_reason = _score_images(frames, prompt, weights)
    report({"phase": "done"})

    candidates = []
    for index, (image_b64, result) in enumerate(zip(encoded, results)):
        candidates.append({
            "image_base64": image_b64,
            "score": result["score"],
            "breakdown": {"clip": result["clip"], "aesthetic": result["aesthetic"]},
            "index": index,
        })
    out = {"candidates": candidates, "clipAvailable": clip_available}
    if clip_reason:
        out["fallbackReason"] = clip_reason
    return out


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
            elif command == "render_sequence":
                out = do_render_sequence(payload, state)
            elif command == "animate_svd":
                _svd_pp = payload.get("progressPath")
                def _svd_report(data, _p=_svd_pp):
                    if not _p:
                        return
                    try:
                        with open(_p, "w", encoding="utf-8") as fh:
                            json.dump(data, fh)
                    except OSError:
                        pass
                out = _animate_svd(payload, state, _svd_report)
            elif command == "evolve_step":
                out = do_evolve_step(payload, state)
            elif command == "preprocess":
                out = do_preprocess(payload)
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
    if command == "render_sequence":
        out = do_render_sequence(json.load(sys.stdin), {"pipe": None, "key": None, "lora_key": None})
        print(json.dumps(out))
        return
    if command == "animate_svd":
        out = _animate_svd(json.load(sys.stdin), {"pipe": None, "key": None, "lora_key": None}, lambda _d: None)
        print(json.dumps(out))
        return
    if command == "evolve_step":
        out = do_evolve_step(json.load(sys.stdin), {"pipe": None, "key": None, "lora_key": None})
        print(json.dumps(out))
        return
    if command == "preprocess":
        print(json.dumps(do_preprocess(json.load(sys.stdin))))
        return
    raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main()
'''


def model_id() -> str:
    return _MODEL_ID


def svd_target_size(width, height):
    """SVD is trained only at 1024x576 (landscape) and 576x1024 (portrait). Snap by
    orientation; square/degenerate defaults to landscape."""
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        return (1024, 576)
    if w <= 0 or h <= 0:
        return (1024, 576)
    return (576, 1024) if h > w else (1024, 576)


def clamp_svd_params(job):
    """Clamp SVD params to safe ranges with conservative 8GB-friendly defaults."""
    def _i(key, default, lo, hi):
        try:
            v = int(job.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))
    try:
        naug = float(job.get("noise_aug_strength", 0.02))
    except (TypeError, ValueError):
        naug = 0.02
    naug = max(0.0, min(1.0, naug))
    return {
        "num_frames": _i("num_frames", 14, 8, 25),
        "fps": _i("fps", 7, 1, 30),
        "motion_bucket_id": _i("motion_bucket_id", 127, 1, 255),
        "noise_aug_strength": naug,
        "decode_chunk_size": _i("decode_chunk_size", 2, 1, 8),
        "num_inference_steps": _i("num_inference_steps", 25, 1, 50),
        "seed": _i("seed", 0, 0, 2**31 - 1),
    }


def is_svd_model(path):
    """True for an SVD diffusers folder (model_index.json class) or an svd*.safetensors."""
    try:
        if os.path.isdir(path):
            idx = os.path.join(path, "model_index.json")
            if os.path.isfile(idx):
                with open(idx, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                # A malformed model_index.json can parse to a non-dict; never crash the scan.
                return isinstance(data, dict) and data.get("_class_name") == "StableVideoDiffusionPipeline"
            return False
        name = os.path.basename(path).lower()
        if not name.endswith(".safetensors"):
            return False
        return name.startswith("svd") or ("svd" in name and "img2vid" in name)
    except (OSError, ValueError, AttributeError, TypeError):
        return False


def find_svd_models(models_dir):
    """Discover SVD models under models_dir: any diffusers folder (model_index.json ==
    SVD) or any svd*.safetensors, RECURSIVELY (matches how discover_model_dir walks, so
    the common ComfyUI/Fooocus `models/checkpoints/svd_xt.safetensors` layout is found).
    Tolerant of None / a missing dir (returns [])."""
    out = []
    if not models_dir:
        return out
    seen = set()
    try:
        walker = os.walk(models_dir)
    except (OSError, TypeError):
        return out
    for root, dirs, files in walker:
        # A diffusers SVD folder is identified by its own model_index.json.
        if is_svd_model(root) and root not in seen:
            seen.add(root)
            out.append({"id": os.path.basename(root) or root, "name": os.path.basename(root) or root, "path": root, "kind": "folder"})
            dirs[:] = []  # don't descend into a matched diffusers folder
            continue
        for name in files:
            full = os.path.join(root, name)
            if is_svd_model(full) and full not in seen:
                seen.add(full)
                out.append({"id": name, "name": name, "path": full, "kind": "file"})
    out.sort(key=lambda m: m["path"])
    return out


def _encode_sequence(frames, fps, fmt="mp4", loop=True):
    """Encode a list of PIL RGB frames into a base64 video (module-level, testable).

    Mirrors the worker's in-process encoder so the format-selection contract can be
    unit-tested. format 'mp4' (default): H.264/avc1 via imageio + imageio-ffmpeg's
    bundled libx264 (pixelformat yuv420p, +faststart) — WebView2/Chromium's <video>
    element can ONLY decode H.264/VP8/VP9/AV1, NOT the MPEG-4 Part 2 'mp4v' that
    cv2.VideoWriter emitted (which loaded as a black player). If the ffmpeg encoder
    is unavailable OR fails, fall back to GIF. format 'gif' (or the mp4 fallback):
    Pillow save_all. Returns {video_base64, mediaType, mimeType, extension}. Never
    silent — the mp4 fallback prints why it dropped to gif.
    """
    import base64 as _base64
    import io as _io
    import tempfile as _tempfile

    fmt = str(fmt or "mp4").lower()
    if not frames:
        raise RuntimeError("cannot encode a video with zero frames")
    fps = max(1, min(30, int(fps or 8)))

    # All frames must share one canvas. A motion clip can animate a size-affecting
    # param (canvas width/height, hires scale) -> frames of differing dimensions.
    # cv2.VideoWriter silently DROPS mismatched frames and GIF assembly corrupts,
    # so conform every frame to the first frame's size: a valid uniform video, never
    # a silent truncation (spec: no silent placeholders).
    base_size = frames[0].size
    frames = [f if f.size == base_size else f.resize(base_size) for f in frames]

    if fmt == "mp4":
        try:
            import imageio.v2 as _imageio
            import numpy as np

            width, height = frames[0].size
            # yuv420p (the browser-safe H.264 chroma format) requires EVEN width and
            # height. Pad by edge-replication rather than crop (spec: never a silent
            # truncation). macro_block_size=1 stops imageio's own /16 auto-resize.
            pad_w = width + (width % 2)
            pad_h = height + (height % 2)
            arrays = []
            for frame in frames:
                arr = np.asarray(frame.convert("RGB"))
                if pad_h != height or pad_w != width:
                    arr = np.pad(arr, ((0, pad_h - height), (0, pad_w - width), (0, 0)), mode="edge")
                arrays.append(arr)
            tmp = _tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
            tmp_path = tmp.name
            tmp.close()
            try:
                writer = _imageio.get_writer(
                    tmp_path, format="FFMPEG", mode="I", fps=float(fps),
                    codec="libx264", pixelformat="yuv420p", macro_block_size=1,
                    ffmpeg_params=["-movflags", "+faststart", "-preset", "veryfast"],
                )
                try:
                    for arr in arrays:
                        writer.append_data(arr)
                finally:
                    writer.close()
                with open(tmp_path, "rb") as fh:
                    data = fh.read()
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if not data:
                raise RuntimeError("ffmpeg produced an empty mp4")
            return {
                "video_base64": _base64.b64encode(data).decode("ascii"),
                "mediaType": "video",
                "mimeType": "video/mp4",
                "extension": "mp4",
            }
        except Exception as exc:
            print(f"[render_sequence] h264 mp4 encode failed, falling back to gif: {exc}", file=sys.stderr, flush=True)

    if fmt == "webm":
        try:
            import imageio.v2 as _imageio
            import numpy as np

            width, height = frames[0].size
            pad_w = width + (width % 2)
            pad_h = height + (height % 2)
            arrays = []
            for frame in frames:
                arr = np.asarray(frame.convert("RGB"))
                if pad_h != height or pad_w != width:
                    arr = np.pad(arr, ((0, pad_h - height), (0, pad_w - width), (0, 0)), mode="edge")
                arrays.append(arr)
            tmp = _tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
            tmp_path = tmp.name
            tmp.close()
            try:
                writer = _imageio.get_writer(
                    tmp_path, format="FFMPEG", mode="I", fps=float(fps),
                    codec="libvpx-vp9", pixelformat="yuv420p", macro_block_size=1,
                    ffmpeg_params=["-b:v", "0", "-crf", "32", "-movflags", "+faststart"],
                )
                try:
                    for arr in arrays:
                        writer.append_data(arr)
                finally:
                    writer.close()
                with open(tmp_path, "rb") as fh:
                    data = fh.read()
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            if not data:
                raise RuntimeError("ffmpeg produced an empty webm")
            return {
                "video_base64": _base64.b64encode(data).decode("ascii"),
                "mediaType": "video",
                "mimeType": "video/webm",
                "extension": "webm",
            }
        except Exception as exc:
            print(f"[render_sequence] vp9 webm encode failed, falling back to gif: {exc}", file=sys.stderr, flush=True)

    if fmt == "frames":
        import zipfile as _zip

        zbuf = _io.BytesIO()
        with _zip.ZipFile(zbuf, "w", _zip.ZIP_DEFLATED) as zf:
            for index, frame in enumerate(frames):
                fbuf = _io.BytesIO()
                frame.convert("RGB").save(fbuf, format="PNG")
                zf.writestr("frame_%04d.png" % (index + 1), fbuf.getvalue())
        return {
            "video_base64": _base64.b64encode(zbuf.getvalue()).decode("ascii"),
            "mediaType": "archive",
            "mimeType": "application/zip",
            "extension": "zip",
        }

    buf = _io.BytesIO()
    frames[0].save(
        buf, format="GIF", save_all=True, append_images=frames[1:],
        duration=int(1000 / fps), loop=0 if loop else 1, disposal=2,
    )
    return {
        "video_base64": _base64.b64encode(buf.getvalue()).decode("ascii"),
        "mediaType": "video",
        "mimeType": "image/gif",
        "extension": "gif",
    }


def estimate_family(model_ref: dict[str, Any] | None) -> str:
    """Best-effort 'SD1.5' | 'SD2.1' | 'SDXL' WITHOUT torch or loading weights.

    Single-file checkpoints: read the safetensors JSON header (8-byte little-endian
    length + JSON, tensor names/shapes only) and apply the same key heuristics the
    worker's detect_single_file_family uses, plus SD2.1 signals (open_clip text
    encoder prefix / 1024-dim cross-attention keys). Hub ids: name heuristics —
    'xl' is checked first so 'sdxl-turbo' never reads as SD2.1; 'sd-turbo' is
    SD2.1-based. Render time re-detects from pipe.unet.config.cross_attention_dim,
    so this only has to be right enough for the capabilities route."""
    ref = model_ref or {"kind": "hub"}
    if ref.get("kind") == "file":
        path = str(ref.get("path", ""))
        try:
            with open(path, "rb") as fh:
                header_len = struct.unpack("<Q", fh.read(8))[0]
                header = json.loads(fh.read(header_len))
            keys = header.keys()
            if any(("conditioner.embedders.1" in k) or ("add_embedding" in k) or (".label_emb." in k) for k in keys):
                return "SDXL"
            # open_clip text encoder layout — the SD2.x single-file signature.
            if any(k.startswith("cond_stage_model.model.") for k in keys):
                return "SD2.1"
            for key, meta in header.items():
                if key.endswith("attn2.to_k.weight") and isinstance(meta, dict):
                    shape = meta.get("shape") or []
                    if len(shape) == 2 and int(shape[1]) == 1024:
                        return "SD2.1"
            return "SD1.5"
        except Exception:
            hint = (str(ref.get("family", "")) + " " + Path(path).name).lower()
            return "SDXL" if "xl" in hint else "SD1.5"
    hub_id = str(ref.get("id") or _MODEL_ID).lower()
    if "xl" in hub_id:
        return "SDXL"
    if any(sig in hub_id for sig in ("sd-turbo", "sd2", "stable-diffusion-2", "v2-")):
        return "SD2.1"
    return "SD1.5"


# --- GTX 1650 4GB low-VRAM worker helpers -----------------------------------
# These four functions are the TESTED module-level mirrors of the copies embedded
# in _WORKER_SOURCE (the subprocess runs in its own namespace, so the worker
# cannot import these). Keep the two copies in sync — same pattern as
# detect_single_file_family (worker) / estimate_family (module).

_CUDA_OOM_SIGNATURES = (
    "cuda out of memory",
    "out of memory",
    "outofmemoryerror",
    "cublas_status_alloc_failed",
    "hip out of memory",
)


def is_cuda_oom(err: Any) -> bool:
    """True when an exception or message is a CUDA out-of-memory. Intentionally
    precise: unrelated exceptions must NOT be treated as OOM (never swallowed)."""
    text = str(err).lower()
    return any(sig in text for sig in _CUDA_OOM_SIGNATURES)


def worker_dtype_name(mem: dict | None, cuda: bool, bf16_supported: bool = False) -> str:
    """Precision the worker loads in: 'float16' | 'bfloat16' | 'float32'.

    Legacy behavior when `mem` is falsy: float16 on CUDA, float32 otherwise.
    Honors mem['precision'] ('fp16'|'mixed'|'fp32'|'bf16'). bf16 is only ever
    returned when the profile asked for it AND hardware confirms it (never merely
    because it 'sounds' memory-efficient)."""
    if not cuda:
        return "float32"
    prec = str((mem or {}).get("precision", "")).lower()
    if prec == "fp32":
        return "float32"
    if prec == "bf16":
        return "bfloat16" if bf16_supported else "float16"
    return "float16"


def detect_hardware(torch: Any) -> dict[str, Any]:
    """Best-effort GPU detection from a torch module. NEVER raises — a detection
    failure returns cuda False + unknowns so the bridge still launches offline and
    without an NVIDIA GPU. Reports name, total/free VRAM (MB), compute capability,
    and bf16 support when reliably readable."""
    info: dict[str, Any] = {
        "cuda": False,
        "cudaInitFailed": False,
        "gpuName": None,
        "totalVramMb": None,
        "freeVramMb": None,
        "computeCapability": None,
        "bf16Supported": False,
    }
    try:
        cuda = bool(torch.cuda.is_available())
    except Exception:
        info["cudaInitFailed"] = True
        return info
    info["cuda"] = cuda
    if not cuda:
        return info
    try:
        props = torch.cuda.get_device_properties(0)
        info["gpuName"] = getattr(props, "name", None)
        total = getattr(props, "total_memory", None)
        if total:
            info["totalVramMb"] = int(total) // (1024 * 1024)
        major = getattr(props, "major", None)
        minor = getattr(props, "minor", None)
        if major is not None and minor is not None:
            info["computeCapability"] = f"{major}.{minor}"
    except Exception:
        info["cudaInitFailed"] = True
    try:
        free, _total = torch.cuda.mem_get_info()
        info["freeVramMb"] = int(free) // (1024 * 1024)
    except Exception:
        pass
    try:
        info["bf16Supported"] = bool(torch.cuda.is_bf16_supported())
    except Exception:
        info["bf16Supported"] = False
    return info


def release_gpu_refs(state: dict) -> None:
    """Drop every resident pipe reference BEFORE requesting a CUDA cache release,
    restoring `state` to a usable empty-model condition after a failed load or OOM
    (spec: clear references before cache cleanup; restore a usable interface)."""
    for key in ("pipe", "anim_pipe", "svd_pipe"):
        state[key] = None
    for key in ("key", "anim_key", "svd_key", "lora_key"):
        state[key] = None
    state["controlnets"] = {}
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


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


# On the windowless desktop app, a bare subprocess pops a black console for every
# probe/install. CREATE_NO_WINDOW suppresses it (0 = harmless no-op off Windows).
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _run(cmd: list[str], timeout: int = 1200, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=True,
        creationflags=_NO_WINDOW,
    )


def _bundled_python_path(base_dir, direct: bool = False) -> Path | None:
    """Path to a bundled interpreter under `base_dir`, or None. Always checks the
    bundled `base/python/…` subdir layout. `direct=True` ALSO accepts `base` being
    the python dir itself (env-hint only) — the relative-search bases must NOT set
    it, or `base/python.exe` would greedily match the running interpreter's own dir."""
    base = Path(base_dir)
    if os.name == "nt":
        cands = [base / "python" / "python.exe"]
        if direct:
            cands.append(base / "python.exe")
    else:
        cands = [base / "python" / "bin" / "python3", base / "python" / "bin" / "python"]
        if direct:
            cands += [base / "bin" / "python3", base / "bin" / "python"]
    for cand in cands:
        try:
            if cand.is_file():
                return cand
        except OSError:
            pass
    return None


def _bundled_python() -> list[str] | None:
    """Find the app-bundled Python (python-build-standalone). Checks an explicit
    env hint, then locations relative to the frozen sidecar exe and this module —
    so the desktop resource dir, a from-source checkout, and the portable bundle
    all resolve. Returns a cmd list or None (validated later by _probe_python)."""
    hint = os.environ.get("LUMENDECK_BUNDLED_PYTHON")
    if hint:
        hp = Path(hint)
        try:
            if hp.is_file():
                return [str(hp)]
        except OSError:
            pass
        found = _bundled_python_path(hp, direct=True)  # hint may point at the python dir itself
        if found:
            return [str(found)]
    bases: list[Path] = []
    try:
        exe_dir = Path(sys.executable).resolve().parent
        # Frozen sidecar / portable: the bundled python is a `python/` SUBdir of
        # one of these — never `exe_dir` itself (that is the running interpreter).
        bases += [exe_dir, exe_dir.parent, exe_dir.parent / "resources"]
    except Exception:
        pass
    try:
        here = Path(__file__).resolve().parent
        # dev checkout: <repo>/src-tauri/resources/python; portable: <root>/python
        bases += [here.parent / "src-tauri" / "resources", here.parent, here]
    except Exception:
        pass
    for base in bases:
        found = _bundled_python_path(base, direct=False)
        if found:
            return [str(found)]
    return None


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

    # The app-bundled Python (python-build-standalone) is the canonical
    # interpreter: on a machine with NO system Python it is the only one, and it
    # must win over a random system Python that may lack pip or be the wrong
    # version. install_runtime() resets the site dir, so the managed CUDA runtime
    # is (re)built against it consistently.
    bundled = _bundled_python()
    if bundled:
        found = _probe_python(bundled)
        if found:
            _python_cache = found
            return found

    # Next: the interpreter matching the managed CUDA runtime, so GPU rendering
    # actually engages even if the bundled Python is absent (dev / system install).
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
            creationflags=_NO_WINDOW,
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
    only_binary: bool = False,
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
    if only_binary:
        # Never build from source (some pinned sci-stack versions ship an sdist
        # that would try to compile against a mismatched numpy/toolchain).
        cmd += ["--only-binary=:all:"]
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
    # torchvision from the same index so its CUDA build matches torch (timm and
    # several controlnet_aux detectors import it). --no-deps: torch is present.
    _pip_install(["torchvision"], index_url=_torch_index_url(), timeout=2400, no_deps=True)
    _pip_install(
        ["huggingface-hub", "filelock", "numpy==1.26.4", "packaging", "pillow", "pyyaml", "regex", "requests", "tqdm", "tokenizers==0.19.1", "safetensors"],
        timeout=1200,
    )
    _pip_install(["diffusers==0.30.3", "transformers==4.44.2", "accelerate", "kornia"], timeout=1200, no_deps=True)
    # ControlNet preprocessors (controlnet_aux + its leaf deps, named explicitly).
    # --no-deps because their dependency trees reach torch/numpy: a with-deps
    # install would pull PyPI's CPU-only torch (or numpy 2.x) over the CUDA torch
    # and pinned numpy installed above.
    # scipy stays UNpinned so it matches the runtime's numpy ABI (a cp312 runtime
    # gets a numpy<2 scipy, a cp313/cp314 runtime gets a numpy>=2 scipy).
    # only_binary: never fall back to a source build (no toolchain on end-user PCs).
    _pip_install(
        ["opencv-python-headless", "einops", "scipy", "timm==0.9.16", "controlnet_aux==0.0.10"],
        timeout=1800,
        no_deps=True,
        only_binary=True,
    )
    # Motion-clip video encoder: imageio-ffmpeg bundles a static ffmpeg with libx264
    # so we can write browser-playable H.264/avc1 mp4 (WebView2's <video> cannot
    # decode cv2's MPEG-4 Part 2 'mp4v'). Both are python-version-agnostic wheels
    # (imageio: py3-none-any; imageio-ffmpeg: py3-none-<platform>), so only_binary is
    # always satisfiable. no_deps: imageio's numpy/pillow are already installed above.
    _pip_install(
        ["imageio", "imageio-ffmpeg"],
        timeout=1200,
        no_deps=True,
        only_binary=True,
    )
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
    # The worker resolves ControlNet repos from the job so it never duplicates the map.
    job["controlnetMap"] = CONTROLNET_MODELS
    # Persistent worker: the model stays resident, so only the first render pays the
    # multi-GB load cost; later renders reuse it (reloading only on a model switch).
    try:
        out = _persistent_worker.request("generate", job, timeout=1800)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("generate", job, timeout=1800)
    if isinstance(out, dict) and out.get("error"):
        # Preserve the worker's precise error category (e.g. 'cuda_oom') as an
        # attribute so server.py can forward it instead of relying on message text.
        err = RuntimeError(out["error"])
        err.error_category = out.get("errorCategory")
        raise err
    return out


def render_motion(payload: dict) -> dict:
    """Render a keyframed motion clip into a video via the persistent worker.

    payload: {"jobs": [RenderJob...], "fps": int, "format": "mp4"|"gif",
              "progressPath"?: str}. Each job is the standard image RenderJob shape
      (the same one generate() renders); we inject the ControlNet map into each so
      the worker never duplicates that table. The model stays resident across all
      frames — one load, N renders. Raises loudly on bad input or a missing runtime.
    """
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    jobs = payload.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("render_motion needs a non-empty 'jobs' list")
    for index, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise RuntimeError(f"render_motion job {index} is not an object")
        # The worker resolves ControlNet repos from the job so it never duplicates the map.
        job["controlnetMap"] = CONTROLNET_MODELS
    worker_payload = {
        "jobs": jobs,
        "fps": int(payload.get("fps", 8)),
        "format": str(payload.get("format", "mp4")),
    }
    if payload.get("progressPath"):
        worker_payload["progressPath"] = payload["progressPath"]
    try:
        out = _persistent_worker.request("render_sequence", worker_payload, timeout=3600)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("render_sequence", worker_payload, timeout=3600)
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(out["error"])
    return out


def animate_svd(payload: dict) -> dict:
    """Image->video via SVD on the resident worker. Raises loudly on error."""
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    if not payload.get("image"):
        raise RuntimeError("animate_svd needs an 'image'")
    if not payload.get("modelPath"):
        raise RuntimeError("No SVD model selected. Put a Stable Video Diffusion model in your models folder.")
    try:
        out = _persistent_worker.request("animate_svd", payload, timeout=3600)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("animate_svd", payload, timeout=3600)
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(out["error"])
    return out


def evolve_step(payload: dict) -> dict:
    """Render + score one generation's candidate population via the resident worker.

    payload: {"jobs": [RenderJob...], "prompt": str, "weights": {"clip","aesthetic"},
              "progressPath"?: str}. Each job is the standard image RenderJob shape
      (the same one generate() renders); we inject the ControlNet map into each so
      the worker never duplicates that table. The model stays resident across the
      whole population -- one load, N renders -- then the scorer scores each
      candidate. Returns {"candidates": [{image_base64, score, breakdown{clip,
      aesthetic}, index}], "clipAvailable": bool, "fallbackReason"?: str}. Raises
      loudly on bad input or a missing runtime (evolve REQUIRES real renders).
    """
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    jobs = payload.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise RuntimeError("evolve_step needs a non-empty 'jobs' list")
    for index, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise RuntimeError(f"evolve_step job {index} is not an object")
        # The worker resolves ControlNet repos from the job so it never duplicates the map.
        job["controlnetMap"] = CONTROLNET_MODELS
    worker_payload = {
        "jobs": jobs,
        "prompt": str(payload.get("prompt", "")),
        "weights": payload.get("weights") or {},
    }
    if payload.get("progressPath"):
        worker_payload["progressPath"] = payload["progressPath"]
    try:
        out = _persistent_worker.request("evolve_step", worker_payload, timeout=3600)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("evolve_step", worker_payload, timeout=3600)
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(out["error"])
    return out


def preprocess(job: dict) -> dict:
    """Run one ControlNet preprocessor in the worker (rack Preview, no render).

    job: {"type": <control type>, "image": <base64 or data URL>, "width"?, "height"?}
    -> {"map_base64": "<raw base64 PNG>"}."""
    status = model_status()
    if not status.get("dependenciesReady"):
        raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")
    job = dict(job)
    job["controlnetMap"] = CONTROLNET_MODELS  # harmless; keeps worker inputs uniform
    try:
        out = _persistent_worker.request("preprocess", job, timeout=900)
    except RuntimeError as exc:
        if "worker exited unexpectedly" not in str(exc).lower():
            raise
        out = _worker("preprocess", job, timeout=900)
    if isinstance(out, dict) and out.get("error"):
        raise RuntimeError(out["error"])
    return out


def capabilities(model_query: str | None, shelf: list | None, model_dir: str | None) -> dict[str, Any]:
    """ControlNet capabilities for a shelf model id — pure metadata, no torch.

    Resolves the id to a modelRef exactly the way /generate does (server's
    _model_ref_for), estimates the family, and reads the type list off
    CONTROLNET_MODELS. A missing query resolves to the same default model
    /generate would use."""
    # server imports this module at load, so resolve its _model_ref_for lazily.
    # Prefer the already-loaded instance: 'server' when imported as a module
    # (tests), '__main__' when server.py IS the process (frozen sidecar, manual
    # runs) — a fresh import only as a last resort.
    _model_ref_for = None
    for mod_name in ("server", "__main__"):
        candidate = getattr(sys.modules.get(mod_name), "_model_ref_for", None)
        if candidate is not None:
            _model_ref_for = candidate
            break
    if _model_ref_for is None:
        from server import _model_ref_for
    model_ref = _model_ref_for(str(model_query or ""), list(shelf or []), model_dir)
    family = estimate_family(model_ref)
    return {"family": family, "types": list(CONTROLNET_MODELS.get(family, {}))}
