"""Tests for bundled-Python discovery + the console-flash subprocess fix.

No real Python download required — resolution is exercised with fake dirs and
monkeypatched probes.
"""
import os
import tempfile
from pathlib import Path

import diffusers_backend as db


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def test_bundled_python_path_finds_exe_when_present():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        exe = base / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
        _touch(exe)
        found = db._bundled_python_path(base)
        assert found is not None
        assert found == exe


def test_bundled_python_path_none_when_absent():
    with tempfile.TemporaryDirectory() as tmp:
        assert db._bundled_python_path(Path(tmp)) is None


def test_bundled_python_path_accepts_base_that_is_the_python_dir_only_with_direct():
    # env/hint may point directly at the python/ dir — but ONLY with direct=True.
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        exe = base / ("python.exe" if os.name == "nt" else "bin/python3")
        _touch(exe)
        assert db._bundled_python_path(base, direct=True) == exe
        # Regression: without direct, a bare interpreter dir must NOT match — else
        # the sys.executable-relative search returns the RUNNING interpreter's dir.
        assert db._bundled_python_path(base, direct=False) is None


def test_bundled_python_honors_env_hint_dir():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        exe = base / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
        _touch(exe)
        old = os.environ.get("LUMENDECK_BUNDLED_PYTHON")
        os.environ["LUMENDECK_BUNDLED_PYTHON"] = str(base)
        try:
            cmd = db._bundled_python()
        finally:
            if old is None:
                os.environ.pop("LUMENDECK_BUNDLED_PYTHON", None)
            else:
                os.environ["LUMENDECK_BUNDLED_PYTHON"] = old
        assert cmd == [str(exe)]


def test_bundled_python_honors_env_hint_file():
    with tempfile.TemporaryDirectory() as tmp:
        exe = Path(tmp) / ("python.exe" if os.name == "nt" else "python3")
        _touch(exe)
        old = os.environ.get("LUMENDECK_BUNDLED_PYTHON")
        os.environ["LUMENDECK_BUNDLED_PYTHON"] = str(exe)
        try:
            cmd = db._bundled_python()
        finally:
            if old is None:
                os.environ.pop("LUMENDECK_BUNDLED_PYTHON", None)
            else:
                os.environ["LUMENDECK_BUNDLED_PYTHON"] = old
        assert cmd == [str(exe)]


def test_find_python_prefers_bundled_over_system():
    saved = (db._python_cache, db._bundled_python, db._managed_runtime_python, db._probe_python)
    old_env = os.environ.get("LUMENDECK_PYTHON")
    os.environ.pop("LUMENDECK_PYTHON", None)
    db._python_cache = False
    db._bundled_python = lambda: ["/opt/lumendeck/python/python.exe"]
    db._managed_runtime_python = lambda: {"cmd": ["C:/system/python.exe"], "version": "3.11.0"}
    db._probe_python = lambda cmd: {"cmd": cmd, "version": "3.12.8"}
    try:
        found = db._find_python()
    finally:
        (db._python_cache, db._bundled_python, db._managed_runtime_python, db._probe_python) = saved
        db._python_cache = False
        if old_env is not None:
            os.environ["LUMENDECK_PYTHON"] = old_env
    assert found == {"cmd": ["/opt/lumendeck/python/python.exe"], "version": "3.12.8"}


def test_run_passes_no_window_creationflags():
    captured = {}
    real = db.subprocess.run

    class _Result:
        stdout = ""
        stderr = ""
        returncode = 0

    def fake_run(cmd, **kwargs):
        captured.update(kwargs)
        return _Result()

    db.subprocess.run = fake_run
    try:
        db._run(["echo", "hi"])
    finally:
        db.subprocess.run = real
    assert "creationflags" in captured
    assert captured["creationflags"] == db._NO_WINDOW


def test_no_window_constant_is_zero_off_windows():
    # On Windows it must be CREATE_NO_WINDOW; elsewhere a harmless 0.
    if os.name == "nt":
        assert db._NO_WINDOW == db.subprocess.CREATE_NO_WINDOW
    else:
        assert db._NO_WINDOW == 0


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("bundled python: all checks passed")
