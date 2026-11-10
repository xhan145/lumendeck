# LUMENDECK

**A local-first creative workspace. Files become spatial, context becomes visible, and AI remains optional.**

![LumenDeck wordmark](https://i.postimg.cc/8ztj4bRw/lumendeck-wordmark-1600.png)

LUMENDECK is a Windows-first desktop application built with **Tauri, React, TypeScript, and Three.js**. It combines a native-file workspace with spatial visualization and a node-based creative studio. Its direction is a practical desktop environment for organizing and creating, not a flashy replacement for ordinary file operations.

**Repository description:** Windows-first, local-first creative workspace with native file navigation, GPU spatial constellations, time/context/spectrum views, and optional AI rendering.

**Status:** Development-source milestone **0.36.0**, tracked in [Spatial Experience PR #53](https://github.com/xhan145/lumendeck/pull/53). Spatial Files, 4D Spacetime, 5D Context, and 6D Spectrum remain **experimental** until native Windows GPU and installer QA. A version bump or merged PR is **not** a signed installer release. Windows Explorer shell replacement is not implemented.

## What LUMENDECK does

- **Creative studio:** A node-based environment for local image-generation workflows, render settings, models, and outputs.
- **Native Files workspace (experimental):** Navigate actual Windows folders and drives in List, Grid, or Constellation views. Open real files, inspect bounded previews and metadata, use bookmarks and saved camera views. The visual layer does not duplicate or relocate files.
- **Spatial Constellation (experimental):** Group real files into a GPU-rendered, selectable 3D map. Orbit, zoom, focus, inspect, and open file stars. An accessible List view remains available.
- **4D Time and Spacetime (experimental):** Scrub real last-modified timestamps; project them onto the 3D scene. A low-contrast, shader-driven **Spacetime** field provides Off, Contours, and Flow modes.
- **5D Context (experimental):** Show local, explainable relationships based on filename, extension, type, and modification-date evidence. **These are heuristic metadata matches**, not verified semantic dependencies.
- **6D Spectrum (experimental):** Encode file type, proximity to the time playhead, and contextual evidence as subtle star gradients. Choose Off, Gradient, or Drift. Drift is cosmetic, not a live file-change indicator.
- **Optional AI rendering:** A bundled/locally launched procedural bridge and an optional managed **Diffusers + PyTorch** workflow. Downloading models or enabling external providers requires a deliberate choice and may require network access.

Here, **X · Y · Z · T · C · S** means three spatial display coordinates, a real file-time projection, a contextual-evidence encoding, and a chromatic display channel. It does **not** claim six physical dimensions, reconstructed file history, or autonomous understanding of personal files.

## Design principles

**Real files first.** Visual stars refer to real filesystem entries. File operations require explicit interaction; spatial effects do not create, rename, delete, or move data. LUMENDECK is **not currently an OS-level Explorer replacement** and does not need to change Windows shell registry settings.

**Useful rather than overproduced.** Deep indigo/purple, legible typography, precise gradients, subtle depth, and restrained bloom. GPU work should make the interface clearer and smoother, not simply increase GPU utilization.

**Local-first and bounded.** File visualization uses local metadata without cloud upload or silent recursive indexing. Optional cloud, AI downloads, and publishing integrations have separate privacy and network considerations. The draft Files implementation caps the 3D scene at **180 visible stars**, with fuller access through List view.

**Graceful failure.** Reduced-motion support, selectable FX tiers, GPU quality fallback, and traditional file-navigation alternatives remain important. No unsupported claim of real-time GPU performance should be made before local testing.

## Status by area

| Area | Status |
| --- | --- |
| Tauri desktop application and creative studio | Existing codebase on `main` |
| Native Files, spatial inspector, bookmarks, 3D Constellation | Implemented as experimental 0.36.0 source in PR #53; Windows GPU QA pending |
| 4D Time + GPU Spacetime | Implemented as experimental 0.36.0 source in PR #53; runtime visual QA pending |
| 5D Context evidence and 6D Spectrum | Implemented as experimental 0.36.0 source in PR #53; heuristic/display-only |
| Optional local AI model runtime | Available through the bridge, requires compatible Python and additional dependencies |
| Full Windows desktop shell replacement | **Not implemented**; exploratory direction only |

For implementation details and honest limitations, see the [Files technical guide](https://github.com/xhan145/lumendeck/blob/ux/shell-first-desktop/docs/files-constellation.md) and [Spatial Experience specification](https://github.com/xhan145/lumendeck/blob/ux/shell-first-desktop/docs/spatial-experience-1.0.md).

## Windows development setup

**Prerequisites:** Windows 10/11 with WebView2, Node.js 22, Rust stable (MSVC target), and Visual Studio C++ Build Tools / Windows SDK. Native Tauri builds should run from an appropriately initialized Visual Studio x64 developer environment. Hardware requirements vary with the selected renderer and local AI models.

### Run the development UI

```powershell
git clone https://github.com/xhan145/lumendeck.git
Set-Location lumendeck
npm.cmd ci
npm.cmd run dev
```

The command above starts the Vite development UI; it is not an installer. For native Windows testing, use the Tauri workflow below.

### Run native Files + Spacetime locally

Use a **separate worktree** to preserve your original checkout and unfinished work:

```powershell
git fetch origin main
git worktree add --detach ../lumendeck-spatial-preview origin/main
Set-Location ../lumendeck-spatial-preview
npm.cmd ci
npm.cmd run tauri:dev
```

If you already have that worktree, do not run `git worktree add` again. Ensure it has no changes before updating its checkout. The `tauri:dev` command uses a development config that does not require a prepackaged sidecar; the Vite server can start the local Python bridge separately. Stop older dev servers first if ports conflict.

In the app, open **Files → Constellation**, choose Particle FX **Balanced** or **Cinematic**, and explore **4D TIME → Spacetime**, **Ⅴ CONTEXT**, and **Ⅵ SPECTRUM**. These are experimental development-source settings, not a promise about an installed release.

### Python and the optional AI bridge

**Experimental packaged-Python path:** Installer builds can include a
checksum-verified, portable Python 3.12 interpreter downloaded using
`npm run fetch:python`. Windows-only `npm run build:portable` creates a
browser-served bundle. Both workflows need clean-machine and GPU testing before
a public installer release. See [portable build documentation](docs/portable.md).
Browser-only builds do not expose Tauri's native Files APIs.


**Python 3.12 (64-bit) is recommended for local source development and Diffusers installation.** The Files/Spacetime WebGL interface itself does not need a Diffusers runtime. During development, the optional Python bridge can start alongside Vite; packaged builds use a bundled bridge executable.

If **Backend → Diffusers → Install runtime + model** says that no compatible Python was found, verify the interpreter and pass its full path to the bridge **before launching it**:

```powershell
$python = (& py -3.12 -c 'import sys; print(sys.executable)' | Select-Object -Last 1)
if (-not $python -or -not (Test-Path -LiteralPath $python)) {
    throw 'Python 3.12 was not found'
}
$env:LUMENDECK_PYTHON = $python
& $env:LUMENDECK_PYTHON --version
```

Restart any old bridge on port **8787**, then launch LUMENDECK from **the same PowerShell session**. A bridge already running cannot inherit a new environment variable. The draft includes a retry for a previously failed Python lookup.

Check readiness without installing anything:

```powershell
$s = Invoke-RestMethod http://127.0.0.1:8787/diffusers/status
$s | Select-Object installable, dependenciesReady, message
$s.managedRuntime.installer
```

`installable = True` means Python was found; **it does not mean PyTorch or the model is already installed**. Model downloads and runtime dependencies can consume several gigabytes. See the [bridge guide](bridge/README.md) for the complete setup and supported backends.

## Verification and contributions

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Windows CI also checks Rust code, filesystem tests, and Python interpreter-discovery tests. CI does **not** validate runtime GPU appearance, frame pacing, or the performance of a particular Windows graphics card.

Please use [Issues](https://github.com/xhan145/lumendeck/issues) for reproducible defects. See [CONTRIBUTING.md](CONTRIBUTING.md), [ROADMAP.md](ROADMAP.md), and [docs/vision-dossier.md](docs/vision-dossier.md) for contributions, planned work, and the preserved original product vision.

## Support and license

LUMENDECK is free and open source. Optional development support is available through [MEKHANE Productions on Ko-fi](https://ko-fi.com/mekhaneproductions). Donations are not required to unlock core features.

Licensed under [Apache License 2.0](LICENSE). Copyright 2026 MEKHANE Productions (Gregory Molina).
