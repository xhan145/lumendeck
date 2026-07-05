from pathlib import Path

path = Path("bridge/diffusers_backend.py")
text = path.read_text(encoding="utf-8")

def replace_once(old: str, new: str, label: str) -> None:
    global text
    if old not in text:
        raise SystemExit(f"Could not find expected block: {label}")
    text = text.replace(old, new, 1)

replace_once(
'''def _runtime_dir() -> Path:
    return Path(os.environ.get("LUMENDECK_DIFFUSERS_RUNTIME", _app_data_dir() / "diffusers-runtime"))
''',
'''def _runtime_dir() -> Path:
    configured = os.environ.get("LUMENDECK_DIFFUSERS_RUNTIME") or os.environ.get("LUMENDECK_DIFFUSERS_VENV")
    return Path(configured) if configured else _app_data_dir() / "diffusers-runtime"
''',
"_runtime_dir",
)

anchor = '''def _worker_path() -> Path:
    return _runtime_dir() / "diffusers_worker.py"
'''

helpers = anchor + '''


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
                match = re.search(r"cp3(\\d+)", line)
                if match:
                    return f"3.{match.group(1)}"
    return None


def _managed_runtime_matches(python: dict[str, Any]) -> bool:
    managed_version = _managed_runtime_python_version()
    return bool(managed_version and _python_major_minor(python) == managed_version)
'''

replace_once(anchor, helpers, "runtime helpers")

start = text.index("def _managed_runtime_python() -> dict[str, Any] | None:")
end = text.index("\ndef _find_python()", start)

new_managed = '''def _managed_runtime_python() -> dict[str, Any] | None:
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

'''

text = text[:start] + new_managed + text[end + 1:]

start = text.index("def _find_python() -> dict[str, Any] | None:")
end = text.index("\ndef _worker_error", start)

new_find = '''def _find_python() -> dict[str, Any] | None:
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

'''

text = text[:start] + new_find + text[end + 1:]

start = text.index("def _worker_env(python: dict[str, Any]) -> dict[str, str]:")
end = text.index("\ndef _worker(", start)

new_env = '''def _worker_env(python: dict[str, Any]) -> dict[str, str]:
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

'''

text = text[:start] + new_env + text[end + 1:]

replace_once(
'''def install_runtime() -> dict[str, Any]:
    python = _find_python()
''',
'''def install_runtime() -> dict[str, Any]:
    global _python_cache
    python = _find_python()
''',
"install_runtime global",
)

replace_once(
'''    _pip_install(["diffusers==0.30.3", "transformers==4.44.2", "accelerate", "kornia"], timeout=1200, no_deps=True)
    status = download_model()
''',
'''    _pip_install(["diffusers==0.30.3", "transformers==4.44.2", "accelerate", "kornia"], timeout=1200, no_deps=True)
    _write_python_manifest(python)
    _python_cache = python
    status = download_model()
''',
"install_runtime manifest",
)

path.write_text(text, encoding="utf-8")
print("Patched bridge/diffusers_backend.py")
