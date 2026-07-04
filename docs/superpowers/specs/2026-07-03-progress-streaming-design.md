# LumenDeck — Render Progress Streaming (Spec B, 2026-07-03)

Live per-step progress for bridge renders instead of a dead bar until completion.

> Part of the user-approved v0.3 sequence ("do all", autonomous). Scope: bridge + web UI.

## Problem
`POST /generate` is synchronous; on CPU a real render takes 20s+ (first render: +model load),
during which the queue bar sits at ~5%. The user can't tell loading from rendering from hung.

## Approach: polling a job-progress endpoint (chosen)
SSE/chunked streaming is overkill for a localhost bridge and awkward in stdlib `http.server`;
WebSockets are unavailable in stdlib. Polling every ~600ms is imperceptible locally and works
unchanged through the Vite proxy, the same-origin static server, and the Tauri sidecar.

## Bridge (`bridge/server.py`, `bridge/diffusers_backend.py`)
- In-memory `_PROGRESS: dict[jobId -> {"phase", "step", "steps"}]`, pruned per-job on completion
  (keep last state ~60s via lazy cleanup of finished entries when the dict exceeds 32).
- `POST /generate` reads optional `jobId` from the body. Before diffusers work:
  `phase="loading"`; during sampling: `phase="rendering", step/steps` via diffusers
  `callback_on_step_end`; after: `phase="done"`. Procedural renders set `rendering` then `done`.
- `GET /progress/<jobId>` → the state, or `{"phase":"unknown"}` (200) if not tracked.
- `diffusers_backend.generate(job, on_step=None)` gains an optional
  `on_step(step:int, steps:int)` callback wired into the pipeline; loading is reported by the
  server around `_load()` (server passes phases; backend only reports steps).

## Web (`src/bridge/httpAdapter.ts`, store untouched)
- `generate()` creates `jobId = crypto.randomUUID()`, sends it in the body, and while the POST
  is in flight polls `GET {base}/progress/{jobId}` every 600ms, mapping to the existing
  `onProgress(p)`: `loading → 0.1`, `rendering → 0.15 + 0.8*(step/steps)`, resolve → `1.0`.
  Poll errors are ignored (progress is best-effort); polling stops when the POST settles.
- Queue UI already renders `progress` — no store/UI change required.

## Testing
- Bridge: unit tests — `/progress/x` unknown → `{"phase":"unknown"}`; a fake diffusers backend
  invoking `on_step` updates `_PROGRESS`; `/generate` with `jobId` leaves phase `done`.
- Web: tsc + existing suites; live verification with a real CPU render watching progress move.

## Acceptance
1. During a real render the queue bar advances step-by-step (not stuck at 5%).
2. Model-load phase visibly reports (~10%) before steps begin.
3. Procedural renders still complete instantly; no regression in 74 tests.
