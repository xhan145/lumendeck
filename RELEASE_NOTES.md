# LumenDeck v0.2.0 — Release Notes

Turns LumenDeck into a single installer that launches and can make real images, and adds recipe
portability.

## Highlights

- **Auto-starting bundled bridge.** The render bridge is rewritten as a pure-stdlib HTTP server,
  frozen with PyInstaller into a sidecar exe, and spawned automatically by the desktop app on port
  8787 — no manual `uvicorn` step. It stops with the app via a stdin-EOF watchdog plus Tauri's child
  cleanup. The app auto-selects the bridge on first boot (unless you pick a backend yourself).
- **Real diffusion, three ways.** Backend panel renderer modes: **procedural** (instant, offline,
  always works), **diffusers** (real SD-Turbo via `torch`/`diffusers`, weights fetched on first use),
  and **auto** (real if available, else procedural). The existing **ComfyUI** adapter remains for an
  external ComfyUI server.
- **Recipe save/load + templates.** Save the workflow as a `.lumen` file and re-open it (validated,
  never crashes on bad input); or start from a built-in template — Neon Poster, Ink Sketch, Portrait
  Studio.

## Verification (honest)

- Verified: 67 unit tests pass; `tsc` clean; frozen sidecar serves `/health` and `/generate` (valid
  PNG); the desktop app auto-spawns the sidecar and the watchdog stops it when the parent pipe closes;
  templates apply and mutate the workflow in the live preview; renderer-mode setting round-trips.
- **Not verified in this environment:** real SD-Turbo inference (multi-GB `torch` + weights download,
  CPU-slow) and a reachable ComfyUI server. The diffusers code path is built and guarded; procedural
  is the guaranteed fallback, so a render never fails for lack of a real backend.
- Known edge: a `taskkill /F` hard-kill of the app *tree* can momentarily orphan the PyInstaller
  grandchild; normal window-close and pipe-closing kills are handled by the watchdog.

---

# LumenDeck v0.1.0 — Release Notes

First working release of LumenDeck, a local-first, node-native generative image studio and spiritual
successor to Disco Diffusion.

## Highlights

- **Two synchronized editors on one workflow object.** Recipe View (guided cards) and Graph View
  (editable SVG node graph) edit the same document; changes reflect instantly across both.
- **Editable node graph.** Drag nodes, pan/zoom, wire typed ports with live validation, click a wire
  to disconnect, keyboard move/delete. Invalid connections are refused (type/cycle/self checks).
- **Nine Capsules** — Prompt, Model, LoRA Rack, Control, Sampler, Canvas, Queue, Export, Manifest —
  each edited through a shared, accessible Inspector.
- **Model Shelf** with type/family filters and full metadata: name, family, size, path, SHA, tags,
  license, compatibility notes, installed state.
- **LoRA Rack** — stack multiple LoRAs with independent weights, enable toggles, preset save/apply/
  delete, and live cross-family compatibility warnings.
- **Graph Health** pre-flight checks: missing/uninstalled model, broken link, socket mismatch, bad
  dimensions, LoRA family conflict, VRAM over-budget, disconnected sampler. Render is blocked (with a
  reason) while any error exists.
- **Render backends** behind a single `BackendAdapter` interface: built-in Procedural (offline),
  ComfyUI API, and a new **FastAPI Diffusers bridge** (pure-stdlib PNG renderer + local model scanner).
- **TurboForge acceleration layer** — backend settings/health, render planning, presets, profiler,
  and benchmark history.
- **Gallery + Manifest** — each render records prompt, seed, model, LoRA stack, timestamp, and a full
  graph snapshot; export a reproducibility manifest as JSON, download the PNG, or restore the graph.

## New in this release (on top of the TurboForge layer)

- Custom SVG **Graph View** editor (previously static): drag/pan/zoom, typed-port wiring, wire delete.
- Shared **Inspector** + `CapsuleParams` renderer used by both Recipe and Graph (single edit surface).
- **Model Shelf** upgraded with family/type filters, full metadata, Use-model / Add-to-rack actions.
- **LoRA Rack** upgraded with weight sliders, presets UI, and live compatibility warnings.
- **Gallery detail drawer** with graph snapshot, model/LoRA chips, and PNG + manifest JSON download.
- **Python FastAPI render bridge** (`bridge/`) with `/health`, `/models`, `/generate`, model scanner,
  and a documented A1111 adapter stub.
- Fixes: Zustand selector array-identity render loop; Vite dev port via `PORT` env / autoPort.

## Verification

- `npm test` → **57 passing** (capsules, workflow ops, shelf, health, manifest, render-job, store
  sync, exporter, plus the TurboForge/backend suites).
- `npm run build` → clean `tsc --noEmit` + Vite production build (72 modules, ~72 KB gzip JS).
- Bridge: `python bridge/test_renderer.py` passes; verified live end-to-end from the app
  (Backend → Diffusers bridge → `/generate` → gallery item + manifest).

## Known issues / limitations

- **No bundled real diffusion.** The Procedural renderer and FastAPI bridge are stand-in text-to-image
  paths. Real generation requires ComfyUI (adapter included) or implementing the `A1111Adapter` stub.
- **Gallery persistence is capped** to the most recent ~24 renders (data URLs are large; localStorage
  quota). Older items drop out on reload.
- **No desktop packaging** (Electron/Tauri) yet — runs as a web app plus the optional local bridge.
- The exporter's browser download helpers are DOM-only and are exercised via the app, not unit tests
  (only the pure `slugify` helper is unit-tested).
- Line-ending warnings (LF→CRLF) appear on Windows commits; cosmetic only.

## Next

- Implement a real backend adapter (A1111 `/sdapi/v1/txt2img` or diffusers) behind the bridge.
- Optional IndexedDB gallery store to lift the 24-render cap.
- Multi-workflow tabs and graph import/export from a manifest file.
