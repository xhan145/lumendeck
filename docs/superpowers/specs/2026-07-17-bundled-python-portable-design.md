# LumenDeck — Bundled Python + Portable Browser Bundle (2026-07-17)

Two user-facing goals, one shared foundation:

1. **Desktop installer bug:** the frozen app has no Python, so real GPU rendering
   dead-ends at *"No compatible Python 3.10-3.14 install was found. Install
   Python 3.12, then retry."* Fix: **bundle a Python** so "Install runtime +
   model" works with nothing preinstalled.
2. **Portable browser-served bundle:** ship the bridge + built UI + the bundled
   Python as a self-contained zip. Double-click a launcher → the bridge serves
   the whole app at `http://127.0.0.1:8787` in any browser → real **local GPU**
   rendering, no MSI, no system Python.

Both reduce to: **make LumenDeck run without any preinstalled Python.** The
bridge already serves the SPA same-origin (`run.bat` proves it), so the portable
bundle is mostly packaging once the bundled Python exists.

Approved 2026-07-17: bundle **python-build-standalone** (astral-sh, relocatable
full CPython — pip/ssl/venv behave like a normal install; the reliability the
"just works" goal needs). Target v0.36.0, Windows x64 first.

## Foundation

### `scripts/fetch-python.mjs` (new)
Downloads a pinned python-build-standalone **install_only** CPython 3.12 for
`x86_64-pc-windows-msvc` into `src-tauri/resources/python/` (the archive extracts
a `python/` dir with `python.exe`, full stdlib, and pip).

- Resolve the asset from the `astral-sh/python-build-standalone` GitHub Releases
  API (find `cpython-3.12.*-x86_64-pc-windows-msvc-install_only.tar.gz`), with a
  pinned tag/version fallback and env overrides (`LUMENDECK_PBS_URL`,
  `LUMENDECK_PBS_VERSION`). **SHA256-verify** against the published `.sha256`.
- Idempotent: a `src-tauri/resources/python/VERSION` marker skips re-download
  when it matches. `--force` re-fetches.
- `src-tauri/resources/` is gitignored (a build artifact, not committed).
- This runs at BUILD time (the user's build), fetching a trusted, checksummed
  dependency — same trust model as Tauri/Node fetching their own toolchains.

### `bridge/diffusers_backend.py` — find + prefer the bundled Python
Add pure, testable resolution:
- `_bundled_python_path(base_dir: Path) -> Path | None` — returns
  `base_dir/python/python.exe` (win) if it exists, else None. Pure existence check.
- `_bundled_python() -> list[str] | None` — probe these dirs in order and return
  the first `python.exe` that exists (validation happens via `_probe_python`):
  1. `LUMENDECK_BUNDLED_PYTHON` env (explicit dir or exe hint);
  2. relative to the frozen sidecar exe: `<dirname(sys.executable)>/python/…`,
     `<dirname(sys.executable)>/../resources/python/…` (Tauri resource layout);
  3. relative to this module: `<bridge_dir>/../src-tauri/resources/python/…`
     (dev + portable-from-source layout).

Wire into `_find_python()` between the `LUMENDECK_PYTHON` override and
`_managed_runtime_python()`:
```
env override (LUMENDECK_PYTHON) → bundled python → managed-runtime python → system
```
Rationale: the bundled interpreter is the app's canonical Python — on a
zero-Python machine it is the only one, and it must win over a random system
Python that may lack pip or be the wrong version. `install_runtime()` already
`_reset_site_dir()`s, so a stale runtime built by another interpreter rebuilds
cleanly against the bundled one (pinned cp312 keeps the managed runtime's ABI
consistent thereafter).

### Console-window flash fix (defect, fixed regardless)
Every installer subprocess (`nvidia-smi`, `py`, `pip`, the persistent worker)
runs via `subprocess.run`/`Popen` **without `CREATE_NO_WINDOW`**, so the
windowless desktop app flashes a black console on each probe/install.
- Module constant `_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)` (0 off
  Windows).
- `_run(...)` passes `creationflags=_NO_WINDOW`.
- The `_PersistentWorker._spawn()` `Popen(...)` (line ~2252) passes
  `creationflags=_NO_WINDOW`.
- This is installer/main-process code (outside `_WORKER_SOURCE`), so no
  two-copy concern.

## Deliverable A — desktop MSI works with zero preinstalled Python

- `src-tauri/tauri.conf.json` `bundle.resources`: ship the fetched Python, e.g.
  `"resources/python": "python"` → lands at `<resource_dir>/python/…`.
- `src-tauri/src/lib.rs` sidecar spawn: resolve `app.path().resource_dir()`, and
  when `<resource_dir>/python/python.exe` exists, add
  `.env("LUMENDECK_PYTHON", that_path)` alongside the existing
  `LUMENDECK_PARENT_WATCH`. (The Python side already treats `LUMENDECK_PYTHON` as
  the top override; the `_bundled_python()` fallback covers cases where the env
  is unset.)
- Build pipeline: `npm run build` gains a prebuild that runs `fetch-python.mjs`
  (so `tauri build` finds the resource); `scripts/release.mjs` runs it before the
  Tauri build too. `package.json` script `fetch:python`.

Result: install the MSI, click **Install runtime + model** → the bundled Python
pip-installs the cu128 torch runtime with nothing preinstalled.

## Deliverable B — portable browser-served bundle

### `scripts/build-portable.mjs` (new)
Assembles `dist-portable/LumenDeck-<ver>-portable-win-x64/`:
- `python/` — copied from `src-tauri/resources/python/` (runs `fetch-python.mjs`
  first if absent).
- `bridge/` — the bridge source (`server.py` + all `bridge/*.py`, pure stdlib;
  no frozen exe needed since we ship Python).
- `dist/` — the built SPA (`npm run build` first if absent).
- `LumenDeck.bat` — launcher: `set LUMENDECK_PYTHON=%~dp0python\python.exe`, free
  port 8787, open the browser, then
  `"%~dp0python\python.exe" "%~dp0bridge\server.py" --port 8787`.
- `README.txt` — usage + the first-run "Install runtime + model" note.
- Zip → `dist-portable/LumenDeck-<ver>-portable-win-x64.zip`.
- `package.json` script `build:portable`.

Fully self-contained: unzip → double-click → browser opens → Mock renders
immediately; **Install runtime + model** uses the bundled Python to build the
CUDA torch runtime → real local GPU rendering. Linux/Docker portable (pbs has
Linux builds) is a clean follow-up, out of scope here.

## Testing / verification

- **Python unit tests** (`bridge/test_bundled_python.py`, dual-mode per repo
  convention): `_bundled_python_path` returns the exe when present / None when
  absent; `_bundled_python` honors `LUMENDECK_BUNDLED_PYTHON` and the relative
  fallbacks (fake dirs); `_find_python` prefers a bundled interpreter over a
  system one (monkeypatch `_probe_python`); `_run` forwards `creationflags`
  (monkeypatch `subprocess.run`, assert the kwarg is present).
- **Build-script checks**: run `fetch-python.mjs` (download pbs from astral's
  GitHub release, SHA256-verify, extract) and assert `python/python.exe` exists;
  a trivial `python\python.exe -c "import ssl, sqlite3, sys"` sanity run;
  `build-portable.mjs` produces the expected tree + a non-empty zip.
- **Existing suites stay green**: `tsc --noEmit`, `npx vitest run`, all
  `bridge/test_*.py`.
- **HONEST LIMIT:** this dev machine HAS Python, so a true zero-Python
  end-to-end (bundled Python pip-installing 2.5 GB cu128 torch and doing a real
  GPU render on a clean box) is the user's verification step. What's verified
  here: the resolution/wiring logic, the console-flash fix, the bundle assembles
  with a working launcher, and the bundled interpreter runs. The torch install
  itself is never bundled (far too large) — it stays install-on-first-use,
  powered by the bundled Python.

## Acceptance
1. Desktop MSI on a machine with **no** Python: Install runtime + model succeeds
   (user-verified).
2. No console windows flash during probes/install/render.
3. Portable zip: unzip → launcher → browser app at 127.0.0.1:8787 → Mock renders;
   Install runtime + model builds the CUDA runtime via the bundled Python
   (user-verified).
4. Version files at 0.36.0 in lockstep; all existing tests green.
