# LumenDeck v0.2 — Design Spec (2026-07-03)

Three modules that turn LumenDeck into a single installer that launches and can make
real images, plus recipe portability. Built in order; each is independently testable.

> Approved via Superpowers brainstorming. User chose: real diffusion = **Both**
> (procedural always + ComfyUI + optional bridge diffusers), MSI = **auto-start bundled
> bridge**, and waived further review gates ("no further intervention needed").

## Module 1 — Auto-starting bundled bridge (sidecar)

**Change:** replace the FastAPI/uvicorn bridge with a **pure-stdlib `http.server`**
(`bridge/server.py`) so PyInstaller freezes it into a small, dependency-free exe; the
MSI then needs no Python on the user's machine.

- Routes unchanged: `GET /health`, `GET /models`, `POST /generate`, plus `OPTIONS`
  preflight and permissive localhost CORS. Reuses `renderer.py` and `scanner.py` as-is.
- Port from `--port`/`PORT` env, default 8787. `GET /health` →
  `{"status":"ok","adapter":"procedural","diffusers":<bool>}`.
- **Packaging:** `bridge/build_sidecar.py` invokes PyInstaller (`--onefile`) to produce
  `lumendeck-bridge-x86_64-pc-windows-msvc.exe` into `src-tauri/binaries/`. Declared in
  `tauri.conf.json` as `bundle.externalBin`.
- **Lifecycle:** `main.rs` `setup` spawns the sidecar via `tauri-plugin-shell`
  (`app.shell().sidecar("lumendeck-bridge")`) on port 8787; the plugin terminates it on
  app exit. Capability grants `shell:allow-execute` scoped to the sidecar only.
- **Frontend:** `probeBridge()` gains retry/backoff (≈5 attempts over ~5s) and, when the
  bridge answers and the user has not explicitly chosen another backend, auto-selects
  `bridge`. In-browser procedural (MockAdapter) remains the guaranteed fallback.

**Errors:** sidecar fails/port busy → app keeps working on MockAdapter with a visible
"bridge offline" status. **Tests:** unit tests for the server's route dispatch and arg
parsing (importable without binding a socket); live `curl` smoke of the frozen exe during
build verification.

## Module 2 — Real diffusion ("Both")

- **ComfyUI** (`comfyAdapter.ts`, already implemented): keep; verify reachable-or-clear
  error; ensure the Backend panel surfaces `health()` messages. No rewrite.
- **Bridge diffusers mode:** `bridge/diffusers_backend.py` — lazy `import torch, diffusers`
  guarded by `is_available()`; `generate(job)` uses **SD-Turbo**
  (`AutoPipelineForText2Image`, guidance 0, 1–4 steps, CPU-capable). Weights download to
  the Hugging Face cache on first real render.
- **`/generate` `renderer` field:** `'procedural' | 'diffusers' | 'auto'` (default
  `'auto'`). `auto` = diffusers when importable, else procedural. Backend panel gets a
  bridge-renderer-mode select wired into the render job.

**Verification limitation (explicit):** the diffusers path is built and unit-tested for
availability/argument handling, but full SD-Turbo inference is **not verifiable in this
environment** (multi-GB torch + weights, CPU-slow). Procedural is guaranteed; ComfyUI is
verifiable given a reachable server. **Errors:** `renderer:'diffusers'` requested while
torch is missing → HTTP 503 with a clear message; app falls back to procedural + banner.

## Module 3 — Workflow save/load + template gallery

- **`.lumen` files:** JSON `{ schemaVersion: 1, app: 'LumenDeck', savedAt, workflow,
  rackPresets }`. **Save recipe** button downloads via `exporter.downloadJson` with a
  `.lumen` name. **Open recipe** file picker → `parseLumenFile(text)` (in `core/lumenFile.ts`)
  validates `schemaVersion===1` and node/edge shape → `setWorkflow` + merges `rackPresets`.
- **Template gallery:** built-in starter recipes in `src/data/templates.ts` (≥3: *Neon
  Poster*, *Ink Sketch*, *Portrait Studio*), each a complete `Workflow` with sensible
  params and a default installed checkpoint. A **Templates** picker (modal from the topbar)
  applies a deep-cloned template via `setWorkflow`.
- **Safety:** unknown/newer `schemaVersion` or malformed shape → friendly returned error,
  never a throw/crash; importer copies only known fields.

**Tests:** `parseLumenFile` valid / wrong-version / malformed; export→import round-trip
identity; every template passes `checkHealth` (0 errors) with its default checkpoint.

## Acceptance criteria (v0.2)
1. MSI installs and **auto-launches the bridge**; app shows bridge online with no manual step.
2. Backend panel offers procedural / diffusers / auto; ComfyUI path is reachable-or-clear-error.
3. **Save recipe** yields a `.lumen`; **Open recipe** restores the exact workflow; ≥3
   templates load health-clean.
4. All prior tests remain green; new unit tests for server dispatch, `parseLumenFile`, templates.
5. Honest verification report: what ran vs. what couldn't (real weights).

## Non-goals
- No GPU/driver management; no bundling of torch or model weights inside the MSI (fetched
  on demand). No cloud sync, accounts, or multi-workflow tabs.
