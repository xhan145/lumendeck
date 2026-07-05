# Codex handoff — LumenDeck cloud provider APIs

Copy everything below the line into Codex as the task prompt. It is self-contained.

---

You are continuing work on **LumenDeck** (`C:\Users\xhan1\lumendeck`, remote
`https://github.com/xhan145/lumendeck.git`) — a local-first, node-native generative image/video
studio, spiritual successor to Disco Diffusion. Current version **0.8.0**, tree clean, all work
merged to `main` via PRs. Your task: **add hosted cloud generation backends (Runway, Replicate,
Fal.ai, Stability AI, OpenAI) alongside the existing local backends**, exactly per the committed
design spec `docs/superpowers/specs/2026-07-04-cloud-providers-design.md`. Read that spec first —
this prompt is the concrete implementation guide for it.

If Superpowers skills are available, run brainstorming only if you want to deviate from the spec;
otherwise go straight to `writing-plans` → TDD implementation. Work on a branch and land via PR
(direct pushes to `main` are blocked by a guardrail): `git push origin main:lumendeck-cloud`, open
a PR, merge, then `git pull --ff-only`.

## Why the bridge makes the calls (do not put keys in the browser)

The Python **bridge** (`bridge/server.py`, pure-stdlib, no pip deps — it gets frozen by
PyInstaller) makes all provider HTTP calls. The React app never holds an API key and never makes a
cross-origin request (the bridge serves the built SPA same-origin). Keys persist in
`%LOCALAPPDATA%\LumenDeck\settings.json` under a `cloudKeys` object, chmod-nothing, bridge-only.

**Pure-stdlib constraint:** the bridge cannot `import requests`. Use `urllib.request` /
`urllib.error` / `json` / `base64` / `time` only. This keeps the PyInstaller sidecar dependency-free.

## The result contract (match it exactly)

Every render in LumenDeck returns the SAME shape the local worker returns, so the frontend and
Gallery already handle it:

```python
# image result
{"image_base64": "<raw base64, NO data: prefix>", "seed": "<str>"}
# video result (Gallery renders <video> when mediaType/mime is video/*)
{"video_base64": "<raw base64>", "mediaType": "video", "mimeType": "video/mp4", "extension": "mp4", "seed": "..."}
```

`src/bridge/adapter.ts` defines `RenderJob` (prompt, negativePrompt, seed, steps, cfg, width,
height, sampler, output:'image'|'video', frameCount, fps, initImage?, maskImage?, controlNet?,
etc.) and `RenderResult` (`dataUrl`, `mediaType`, `mimeType`, `extension`, `seed`, `fallback?`,
`fallbackReason?`). The existing `HttpAdapter` converts the worker's `image_base64` →
`data:<mime>;base64,...` dataUrl. Reuse that conversion for cloud results.

## Files to create / edit

### Bridge (Python, stdlib only)
1. **`bridge/cloud.py`** (new) — the provider layer:
   - `class CloudProvider` (ABC): attributes `id`, `label`, `kind` ('image'|'video'|'both');
     methods `models() -> list[{"id","label","kind"}]` and
     `generate(job: dict, key: str, on_progress) -> dict` returning the result contract above.
   - One subclass per provider (see API details below). Async providers (Runway/Replicate/Fal
     video) **submit → poll → download**; call `on_progress({"phase":"queued"|"running","progress":p})`
     each poll so the existing progress file updates.
   - A `_http_json(url, method, headers, body)` helper on `urllib.request` returning parsed JSON,
     and `_http_bytes(url)` for downloading result MP4/PNG URLs → bytes → base64. Raise a
     `CloudError(provider, message)` on any non-2xx with the provider's error body — **never** a
     silent failure.
   - `PROVIDERS = {p.id: p for p in (Runway(), Replicate(), Fal(), Stability(), OpenAI())}`.
2. **`bridge/server.py`** (edit) — add three routes to `build_response()` (keep it a pure
   function so it stays unit-testable) reusing the existing `_JOB_ID` / progress plumbing:
   - `GET /cloud/providers` → `[{id,label,kind,models,hasKey}]` (hasKey from settings.json).
   - `POST /cloud/keys` body `{provider, key}` → persist under `cloudKeys` in settings.json; 200.
   - `POST /cloud/generate` body `{provider, model, ...RenderJob}` → look up provider, load key,
     call `provider.generate(...)`, return the result JSON. On `CloudError` return a JSON error
     with a clear `fallbackReason` (HTTP 200 with `{"error":...}` OR 502 — match how `/generate`
     surfaces worker errors; grep `fallbackReason` in server.py and mirror it). Missing key → 400
     with a clear message.
   - Add a tiny `_settings_path()` / `_load_settings()` / `_save_settings()` if not present
     (write to `%LOCALAPPDATA%\LumenDeck\settings.json`, create dirs, tolerate missing file).

### Frontend (TS/React)
3. **`src/bridge/cloudAdapter.ts`** (new) — implements `BackendAdapter` (`id`, `label`, `ping`,
   `generate`). `generate` POSTs the `RenderJob` + `{provider, model}` to `/cloud/generate`,
   polls `/progress/<jobId>` like `httpAdapter` does, converts `image_base64`/`video_base64` →
   dataUrl, returns `RenderResult` with the right `mediaType`/`mimeType`/`extension`. Surface a
   returned `error` as a thrown error (the store already renders queue errors as a banner).
4. **Backend panel** (find where the backend/adapter is chosen — grep `httpAdapter`, `ComfyAdapter`,
   `backendSettings` under `src/`): add a **Cloud** backend option → provider `<select>` (from
   `GET /cloud/providers`), a per-provider API-key `<input type=password>` with a Save button
   (POST `/cloud/keys`), and a model `<select>` fed by the chosen provider's `models`. Persist
   `cloudProvider` + `cloudModel` in `backendSettings` (Zustand); **never** persist keys in the
   browser.
5. **Health + manifest**: in the graph health checker (`src/core/health*`), warn when the selected
   backend is Cloud and the chosen provider `hasKey === false`. In the manifest writer, record
   `{ backend:'cloud', provider, model }` for cloud renders.

## Provider API details (endpoints + auth)

Implement to these; keep each subclass small. All auth headers over HTTPS.

- **Runway** (video, async) — `Authorization: Bearer <key>`, header `X-Runway-Version: 2024-11-06`.
  `POST https://api.dev.runwayml.com/v1/image_to_video` (or `text_to_video`) with model
  `gen3a_turbo`/`gen4`, `promptText`, optional `promptImage` (data URL from `job.initImage`),
  `duration`, `ratio`. Response has `id`; poll `GET /v1/tasks/{id}` until `status=="SUCCEEDED"`,
  then download `output[0]` URL → base64 MP4.
- **Replicate** (image+video, async) — `Authorization: Bearer <key>`.
  `POST https://api.replicate.com/v1/predictions` `{version:"<model version hash>", input:{prompt,
  ...}}` (map a few curated models to versions in `models()`; e.g. an SDXL and a Flux image model,
  a video model). Poll `GET /v1/predictions/{id}` until `status=="succeeded"`; `output` is a URL or
  list — download → base64. Detect image vs video by extension/mime.
- **Fal.ai** (image+video, async queue) — `Authorization: Key <key>`.
  `POST https://queue.fal.run/<model>` (e.g. `fal-ai/flux/dev`, `fal-ai/fast-sdxl`) with `{prompt,
  image_size, ...}`; response `request_id`; poll `GET https://queue.fal.run/<model>/requests/{id}/status`
  until `COMPLETED`, then `GET .../{id}` for the result; download `images[0].url` → base64.
- **Stability AI** (image, mostly sync) — `Authorization: Bearer <key>`, `Accept: image/*`.
  `POST https://api.stability.ai/v2beta/stable-image/generate/{sd3|core|ultra}` as multipart with
  `prompt`, `aspect_ratio`, `output_format`. Returns image bytes directly → base64. (Multipart in
  stdlib: build the body manually with a boundary; see `urllib` + `email.mime` or hand-rolled
  bytes — keep it simple, only text fields.)
- **OpenAI** (image, sync) — `Authorization: Bearer <key>`.
  `POST https://api.openai.com/v1/images/generations` `{model:"gpt-image-1", prompt, size,
  n:1}`. Response `data[0].b64_json` → base64 (already base64). `dall-e-3` also available.

Curate 2–4 models per provider in `models()`; don't try to enumerate everything.

## Testing / verification (this is the acceptance bar)

- **Unit-test each provider against MOCKED HTTP** — monkeypatch the `_http_json`/`_http_bytes`
  helpers (or `urllib.request.urlopen`) to return recorded sample payloads. Assert: the request
  builder sends the right URL/headers/body, and the response parser produces the result contract.
  Include an async provider poll test with a fake task transitioning `queued → running → succeeded`.
- **Test server routes** through `build_response()` (pure) — `/cloud/providers` shape, `/cloud/keys`
  persistence (temp settings path), `/cloud/generate` success + missing-key error + `CloudError`
  surfaced with `fallbackReason`.
- **Frontend:** a `cloudAdapter` test with a mocked `fetch` (result → dataUrl mapping, error →
  throw). Keep all existing tests green (`npx tsc --noEmit`, `npx vitest run` — currently 82 pass;
  bridge: `python -m pytest bridge/` or the existing `bridge/test_*.py`).
- **HONEST LIMIT — state this in the PR:** live provider calls require real *paid* API keys, which
  are not available in the dev environment. The adapters are built and unit-tested against mocked
  responses; **live verification is the user's step with their own key.** Do not claim a live cloud
  render was verified. The local diffusers pipeline stays the default backend.

## Acceptance (from the spec)
1. Backend → Cloud → pick provider + model + paste key → render returns the provider's image/video
   into the Gallery (verified live by the user with a key).
2. Runway/Replicate/Fal video → MP4 in the Gallery; Stability/OpenAI → images.
3. Missing key → clear health warning + clear error, never a silent placeholder.
4. All existing local backends and tests remain green.

## After it's built
Bump the version (`package.json`, `src/state/storeConstants.ts` `APP_VERSION`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` — keep them in lockstep; never hardcode a
version in a component), rebuild the sidecar (`python bridge/build_sidecar.py`) and MSI
(`npx tauri build`), and confirm the MSI is a valid OLE2 file. Land via PR and update
`docs/CODEX_PROMPT.md` / this file's status line.
