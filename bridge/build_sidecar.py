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
        os.path.join(HERE, "server.py"),
    ])
    os.makedirs(OUT_DIR, exist_ok=True)
    src = os.path.join(HERE, "dist", "lumendeck-bridge.exe")
    dst = os.path.join(OUT_DIR, f"lumendeck-bridge-{TARGET_TRIPLE}.exe")
    shutil.copy2(src, dst)
    print("sidecar ->", dst)


if __name__ == "__main__":
    main()
