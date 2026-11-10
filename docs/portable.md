# Bundled Python & the portable browser bundle

LumenDeck ships a relocatable Python
([python-build-standalone](https://github.com/astral-sh/python-build-standalone))
so packaged LUMENDECK can offer optional AI runtime setup **without a system Python install**. Rendering still requires compatible hardware and model dependencies. `scripts/fetch-python.mjs`
downloads it (SHA256-verified) into `src-tauri/resources/python/` at build time;
it is gitignored, not committed.

## Desktop app

`bundle.resources` ships the bundled Python inside the MSI/exe. On launch the
Rust shell points the render bridge at it (`LUMENDECK_PYTHON`), so **Install
runtime + model** (Settings → Backend) builds the CUDA PyTorch runtime using the
bundled interpreter — the old *"Install Python 3.12, then retry"* dead-end is
gone. (The bridge also finds a bundled Python relative to its own location as a
fallback.) Windows subprocess calls now use `CREATE_NO_WINDOW`, so probes and
installs no longer flash a console.

## Portable bundle (run in any browser, no install)

```bash
npm run build:portable
```

Produces `dist-portable/LumenDeck-<ver>-portable-win-x64/` (+ a `.zip`):

```
python/          bundled Python (build the render runtime; nothing touches your system)
bridge/          the local render server (pure Python stdlib)
dist/            the LumenDeck web app the bridge serves
LumenDeck.bat    launcher: starts the bridge, opens the browser at 127.0.0.1:8787
README.txt
```

Unzip → double-click `LumenDeck.bat` → the browser opens to the full app with
real **local GPU** rendering. It works immediately with the built-in Mock
renderer; **Install runtime + model** uses the bundled Python to fetch the CUDA
torch runtime on first use. No MSI, no system Python.

The multi-GB torch runtime is never bundled (too large) — it stays
install-on-first-use, powered by the bundled Python. Linux/Docker portable
(python-build-standalone has Linux builds) is a natural follow-up.

## Release-readiness boundaries

The portable archive is a **Windows x64, browser-served build**. Browser mode
does not provide Tauri-native Files operations, OS shell replacement, or native
watchdog services. An installer produced by the pinned Python fetch recipe
still needs a clean Windows machine test, checksum verification, signed-update
validation, first-use torch/model download, and actual GPU rendering tests.
Do not equate green source CI with a shipped installer.
