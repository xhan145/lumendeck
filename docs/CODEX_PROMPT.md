# Codex handoff — continue LumenDeck

Copy everything below this line into Codex as the task prompt.

---

You are continuing work on **LumenDeck** (`C:\Users\xhan1\lumendeck`, remote
`https://github.com/xhan145/lumendeck.git`), a local-first, node-native generative image
studio — a spiritual successor to Disco Diffusion. Current version **0.3.0**, working tree
clean, all work merged to `main` via PRs. If Superpowers skills are available, use
brainstorming → spec → plan for anything non-trivial; specs live in `docs/superpowers/specs/`.

## Architecture (read before changing anything)

- **Frontend**: Vite 6 + React 18 + TS strict + Zustand (`src/`). One immutable `Workflow`
  object drives both editors: Recipe View (beginner cards) and Graph View (custom SVG node
  editor). Shared Inspector edits capsule params. Nine capsules: Prompt, Model, LoRA Rack,
  Control, Sampler, Canvas, Queue, Export, Manifest. Pure core logic in `src/core/`
  (workflow ops, health checker, manifest, `.lumen` codec) — keep it React-free and tested.
- **UI**: Material 3 dark-only "ROAR" language. `src/styles/tokens.css` is the single
  source (MD3 palette: primary `#1A73E8`, hero orange `#FF8A00`, surfaces `#12161D/#1A1F29`);
  components consume `--ld-*` aliases only. Left `NavRail`, top bar with glowing `BrandMark`
  + `APP_VERSION` (from `src/state/storeConstants.ts` — never hardcode versions), right
  controls rail that becomes a scrim drawer ≤1023px and icon-rail ≤640px. Keep a11y: focus
  rings, aria labels, reduced-motion, AA contrast.
- **Render bridge**: `bridge/server.py` — **pure-stdlib** HTTP server (no pip deps; it gets
  frozen by PyInstaller via `bridge/build_sidecar.py` into
  `src-tauri/binaries/lumendeck-bridge-x86_64-pc-windows-msvc.exe`). Routes: `/health`,
  `/models`, `/generate`, `/progress/<jobId>`, `/diffusers/status|install|download`. It also
  serves the built `dist/` **same-origin** (SPA fallback), which is the whole point: the
  browser never makes a cross-origin call, so no CORS/"failed to fetch" class of bugs.
  `build_response()` is a pure function — unit-test routes through it.
- **Real diffusion**: `bridge/diffusers_backend.py` runs SD-Turbo in a **subprocess worker**
  (`_WORKER_SOURCE` template written to the managed runtime dir). Model selection: server's
  `_resolve_render_targets()` maps shelf ids → `modelRef` (`{kind:"hub",id}` for
  `diffusers-real`/`diffusers-sdxl`, `{kind:"file",path,family}` for scanned local
  checkpoints via `from_single_file`) and rack LoRAs → `loraFiles` (real files only; demo
  entries skipped). Turbo models get guidance 0 / ≤8 steps; others use job cfg / ≤50 steps.
- **Progress**: worker writes `{phase, step, steps}` to a per-job temp file
  (`lumendeck-progress-<jobId>.json`); `GET /progress/<jobId>` serves it;
  `src/bridge/httpAdapter.ts` polls every 600ms during the POST and maps to `onProgress`.
- **Desktop**: Tauri v2 (`src-tauri/`), WebView2 shell, spawns the sidecar with a kept-alive
  stdin pipe (dropping the child handle kills the sidecar via its stdin-EOF watchdog —
  that's intentional parent-death cleanup; `std::mem::forget(child)` in `main.rs` is
  load-bearing). MSI via `npm run tauri build` →
  `src-tauri/target/release/bundle/msi/LumenDeck_0.3.0_x64_en-US.msi`.
- **Launch paths** (all auto-start the bridge): `run.bat` (build + same-origin serve on
  8787), `npm run dev` (Vite plugin spawns bridge + proxies `/health|/models|/generate|
  /diffusers|/progress` same-origin), desktop app (sidecar).

## Hard-won gotchas (violating these cost hours)

1. **Stale servers on 8787/5178**: Windows SO_REUSEADDR lets two servers bind the same
   port; the old one wins accepts and you debug ghosts. Before testing, kill stale
   `lumendeck-bridge`/`python server.py`/vite processes and confirm exactly one listener.
2. **Worker Python selection**: `_find_python()` prefers `sys.executable` (when not frozen),
   accepts 3.10–3.14. **Never inject the managed site-packages
   (`LUMENDECK_DIFFUSERS_SITE`) into a Python that already imports torch natively** — pinned
   wheels for another Python version shadow numpy and break torch.
3. **Sidecar/worker changes need rebuilds**: editing `_WORKER_SOURCE` rewrites the worker on
   next run, but the frozen sidecar exe needs `python bridge/build_sidecar.py` and the MSI
   needs `npm run tauri build` to pick up bridge changes.
4. Zustand selectors must return stable references (no `.filter()` in selectors — infinite
   render loop). `loadPersisted()` must stay defensive: invalid persisted workflows are
   dropped, never allowed to crash startup.
5. `/health` must stay fast — no torch imports on that path (use `find_spec`/cached status).
6. Bash-tool curl to localhost is flaky here; verify HTTP with Python `urllib` scripts.

## Verify before claiming done

```bash
npx vitest run          # 74 tests, keep green
npx tsc --noEmit
npm run build
cd bridge && python test_server.py && python test_renderer.py && python test_diffusers_backend.py
```
Real-render smoke: start `python bridge/server.py --port 8787`, POST `/generate` with
`renderer:"diffusers"`, a `jobId`, and poll `/progress/<jobId>` — expect
`loading → rendering 0/N..N/N → done` and a PNG. torch/diffusers are installed on this
machine; SD-Turbo weights are cached.

## Known issues / debt (verify → fix as needed)

- `test_server.py::test_models_includes_sdxl_entry` (and possibly the resolve tests) had an
  unconfirmed AssertionError at last run — run the bridge tests FIRST and fix before
  anything else.
- Real-LoRA application and `from_single_file` checkpoints are implemented + unit-tested at
  the resolution layer but **never executed with real weights** (no local
  checkpoint/LoRA files on this machine; sdxl-turbo is a ~7 GB download).
- ComfyUI adapter maps checkpoint by `<modelId>.safetensors` — wrong for real ComfyUI
  installs; should map from the shelf asset's real filename.
- MSI is unsigned (SmartScreen warning). TurboForge "benchmarks" are simulated timings.
- `bridge/main.py` (FastAPI) is deprecated but still shipped.

## Prioritized backlog

1. Fix the failing bridge test(s); rebuild sidecar + MSI; attach MSI to a GitHub Release.
2. Verify real-LoRA + local-checkpoint path end-to-end (small SD1.5 LoRA or scanned
   checkpoint), fix what breaks.
3. ComfyUI checkpoint-filename mapping fix.
4. Img2img + inpainting (new capsule socket usage; worker `AutoPipelineForImage2Image`).
5. Batch/seed sweeps + gallery compare.
6. Code-sign the MSI; auto-provision diffusers runtime on first desktop launch.

## Conventions

Conventional commits; branch → PR → merge to `main` (direct pushes to main are blocked);
spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` before non-trivial work; TDD
for pure logic; honest reporting of what was and wasn't verified. End sessions with: what
changed, files changed, how to run, tests run, known issues, next task.
