"""Real text-to-image via an external Diffusers worker.

The bundled bridge stays tiny and portable. When the user asks for real photos,
it finds a compatible Python 3.10-3.13 runtime, installs missing Diffusers pieces
into an app-local package directory, and runs SD-Turbo in that Python process.
This avoids trying to import CPython extension wheels (torch/safetensors) into
the PyInstaller sidecar's own Python runtime.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
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


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "status":
        print(json.dumps(status()))
        return
    if command == "download":
        load_pipe()
        print(json.dumps(status("SD-Turbo downloaded and loaded for real photo renders.", loaded=True)))
        return
    if command == "generate":
        job = json.load(sys.stdin)
        progress_path = job.get("progressPath")

        def report(data):
            # Best-effort progress channel back to the bridge server (file-based,
            # since this worker is a separate process).
            if not progress_path:
                return
            try:
                with open(progress_path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
            except OSError:
                pass

        report({"phase": "loading"})
        import torch
        model_ref = job.get("modelRef") or {"kind": "hub", "id": MODEL_ID}
        pipe = load_pipe(model_ref)
        apply_loras(pipe, job.get("loraFiles"))
        seed = int(job.get("seed", 0))
        if seed < 0:
            seed = 0
        generator = torch.Generator(device=pipe.device).manual_seed(seed)
        # Turbo-distilled models want no CFG and very few steps; regular
        # checkpoints need real guidance and more steps.
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

        kwargs = dict(
            prompt=str(job.get("prompt", "")),
            negative_prompt=str(job.get("negativePrompt", "")) or None,
            num_inference_steps=steps,
            guidance_scale=guidance,
            width=int(job.get("width", 512)),
            height=int(job.get("height", 512)),
            generator=generator,
        )
        try:
            image = pipe(**kwargs, callback_on_step_end=on_step).images[0]
        except TypeError:
            # Older diffusers without callback_on_step_end — render without progress.
            image = pipe(**kwargs).images[0]
        report({"phase": "done", "step": steps, "steps": steps})
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        print(json.dumps({"image_base64": base64.b64encode(buf.getvalue()).decode("ascii"), "seed": seed}))
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
    return Path(os.environ.get("LUMENDECK_DIFFUSERS_RUNTIME", _app_data_dir() / "diffusers-runtime"))


def _site_dir() -> Path:
    return _runtime_dir() / "site-packages"


def _worker_path() -> Path:
    return _runtime_dir() / "diffusers_worker.py"


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
    """Interpreter matching the managed CUDA runtime's ABI (e.g. cp312).

    The managed runtime installs a CUDA torch built for one Python version. It only
    imports under that exact version, so when the runtime exists we must run the
    worker with a matching interpreter — otherwise we fall back to whatever torch is
    installed system-wide, which is often CPU-only and can't run large models.
    """
    site = _site_dir()
    if not site.exists():
        return None
    tag = None
    for info in site.glob("torch-*.dist-info"):
        wheel = info / "WHEEL"
        if wheel.exists():
            for line in wheel.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.lower().startswith("tag:"):
                    tag = line.split(":", 1)[1].strip()
                    break
        if tag:
            break
    if not tag:
        return None
    match = re.search(r"cp3(\d+)", tag)
    if not match:
        return None
    ver = f"3.{match.group(1)}"
    candidates: list[list[str]] = []
    if os.name == "nt":
        candidates.append(["py", f"-{ver}"])
    candidates.append([f"python{ver}"])
    for candidate in candidates:
        found = _probe_python(candidate)
        if found:
            return found
    return None


def _find_python() -> dict[str, Any] | None:
    global _python_cache
    if _python_cache is not False:
        return _python_cache
    # Highest priority: the interpreter that matches a managed CUDA runtime, so
    # GPU rendering actually engages instead of silently using system CPU torch.
    managed = _managed_runtime_python()
    if managed:
        _python_cache = managed
        return managed
    candidates: list[list[str]] = []
    # Then the interpreter running this bridge — proven importable here.
    # (Skip when frozen: PyInstaller's sys.executable cannot run worker scripts.)
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


def _worker(command: str, payload: dict[str, Any] | None = None, timeout: int = 1800) -> dict[str, Any]:
    python = _find_python()
    if not python:
        raise RuntimeError("No compatible Python 3.10-3.14 install was found. Install Python 3.12, then retry.")
    worker = _write_worker()
    env = os.environ.copy()
    # Only inject the managed site-packages when the chosen Python lacks torch
    # natively. A Python that already has torch must use its own package set —
    # mixing in the managed runtime's pinned wheels (built for another Python
    # version) breaks imports like numpy.
    if _python_has_native_torch(python):
        env.pop("LUMENDECK_DIFFUSERS_SITE", None)
    else:
        env["LUMENDECK_DIFFUSERS_SITE"] = str(_site_dir())
    env["LUMENDECK_DIFFUSERS_MODEL"] = _MODEL_ID
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
    return _worker("generate", payload=job, timeout=1800)
