"""Freeze the stdlib bridge into a Tauri sidecar exe via PyInstaller.

Usage: python bridge/build_sidecar.py   (run from repo root or bridge/).
Produces src-tauri/binaries/lumendeck-bridge-<target-triple>.exe, which
tauri.conf.json references as an externalBin sidecar.
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET_TRIPLE = "x86_64-pc-windows-msvc"
OUT_DIR = os.path.join(ROOT, "src-tauri", "binaries")


def main() -> None:
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller", "--onefile",
        "--name", "lumendeck-bridge",
        "--distpath", os.path.join(HERE, "dist"),
        "--workpath", os.path.join(HERE, "build"),
        "--specpath", HERE,
        # server.py imports diffusers_backend lazily; include it as a hidden import
        # so it is available inside the frozen exe when torch happens to be present.
        "--hidden-import", "diffusers_backend",
        # The heavy ML/vision libs (numpy/cv2/PIL/torch/diffusers/scipy/...) plus the
        # motion-clip video encoder (imageio/imageio-ffmpeg/av — each bundles its own
        # ffmpeg, ~25-40MB) are only ever imported INSIDE diffusers_backend functions
        # that run in the managed runtime *worker subprocess* — never in this frozen
        # stdlib sidecar. Exclude them so PyInstaller doesn't sweep the build Python's
        # globally-installed copies into the exe (that bloats it ~9MB -> ~73MB and
        # trips the 20MB release guard). The worker uses the managed cp314 runtime for
        # real rendering/encoding; the sidecar's own fallbacks are pure stdlib
        # (renderer.py). NOTE: diffusers_backend's module-level _encode_sequence
        # mirror imports imageio, but that function is never CALLED in the sidecar
        # (motion render always goes through the worker), so excluding it is safe.
        *[arg for mod in (
            "numpy", "cv2", "PIL", "torch", "torchvision", "diffusers",
            "transformers", "scipy", "controlnet_aux", "timm", "safetensors",
            "huggingface_hub", "accelerate", "kornia", "einops", "matplotlib",
            "imageio", "imageio_ffmpeg", "av",
        ) for arg in ("--exclude-module", mod)],
        os.path.join(HERE, "server.py"),
    ])
    os.makedirs(OUT_DIR, exist_ok=True)
    src = os.path.join(HERE, "dist", "lumendeck-bridge.exe")
    dst = os.path.join(OUT_DIR, f"lumendeck-bridge-{TARGET_TRIPLE}.exe")
    shutil.copy2(src, dst)
    print("sidecar ->", dst)


if __name__ == "__main__":
    main()
