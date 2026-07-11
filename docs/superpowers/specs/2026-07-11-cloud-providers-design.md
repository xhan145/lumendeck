# LumenDeck — Cloud Provider Backends (2026-07-11, supersedes 2026-07-04 spec)

Add hosted generation backends (OpenAI, Stability AI, Fal.ai, Replicate, Runway) alongside the
local Mock / Bridge (diffusers) / ComfyUI adapters. Approved via brainstorming 2026-07-11:
**all five providers in one build**, targeting v0.33.0. This refresh reconciles the approved
2026-07-04 architecture with the v0.32 codebase (the `BackendAdapter` interface has since grown
`renderMotion`, `animateStill`, `listSvdModels`, and `evolveStep`).

## Architecture — cloud calls go through the bridge (unchanged)

The Python bridge (`bridge/server.py`, pure-stdlib — it gets frozen by PyInstaller) makes all
provider HTTP calls. The React app never holds an API key and never makes a cross-origin
request. **Pure-stdlib constraint:** no `requests`; use `urllib.request` / `urllib.error` /
`json` / `base64` / `time` only.

Keys persist in `%LOCALAPPDATA%\LumenDeck\settings.json` under a `cloudKeys` object
(`{"openai": "sk-...", ...}`), bridge-side only — never in Zustand/localStorage.
`server.py` has no settings persistence today; add `_settings_path()` / `_load_settings()` /
`_save_settings()` (create dirs, tolerate missing/corrupt file → `{}`).

## Result contract (match the local worker exactly)

```python
# image result
{"image_base64": "<raw base64, NO data: prefix>", "seed": "<str>"}
# video result (Gallery renders <video> when mimeType is video/*)
{"video_base64": "<raw base64>", "mediaType": "video", "mimeType": "video/mp4", "extension": "mp4", "seed": "..."}
```

`httpAdapter.generate` already converts `image_base64`/`video_base64` → `data:<mime>;base64,...`
dataUrl; `cloudAdapter` mirrors that conversion.

## Bridge: `bridge/cloud.py` (new)

- `class CloudError(Exception)` carrying `(provider, message)` — raised on any non-2xx with the
  provider's error body; **never a silent failure**.
- `class CloudProvider`: attributes `id`, `label`, `kind` ('image'|'video'|'both'); methods
  `models() -> list[{"id","label","kind"}]` (curated 2–4 per provider, one dict per provider —
  trivially updatable) and `generate(job: dict, model: str, key: str, on_progress) -> dict`
  returning the result contract above.
- Module-level HTTP helpers so tests can monkeypatch them:
  `_http_json(url, method="GET", headers=None, body=None, timeout=120)` → parsed JSON;
  `_http_bytes(url, headers=None, timeout=300)` → raw bytes (for downloading result PNG/MP4
  URLs). Both raise `CloudError` on failure with the response body excerpt.
- Async providers (Fal, Replicate, Runway) **submit → poll → download**; each poll calls
  `on_progress({"phase": "queued"|"running", "progress": p})` so the existing progress file
  updates. Poll interval ~2s, overall deadline ~10 min (video) / ~3 min (image), loud
  `CloudError` on timeout.
- `PROVIDERS: dict[str, CloudProvider]` = OpenAI, Stability, Fal, Replicate, Runway.

### Provider API details

- **OpenAI** (image, sync) — `Authorization: Bearer <key>`.
  `POST https://api.openai.com/v1/images/generations` `{model, prompt, size, n:1}`.
  `data[0].b64_json` is already base64. Models: `gpt-image-1`, `dall-e-3`. Map job WxH to the
  nearest supported size string.
- **Stability AI** (image, sync) — `Authorization: Bearer <key>`, `Accept: image/*`.
  `POST https://api.stability.ai/v2beta/stable-image/generate/{ultra|core|sd3}` as
  multipart/form-data (hand-rolled boundary, text fields only: `prompt`, `negative_prompt`,
  `aspect_ratio`, `output_format=png`, `seed`). Returns raw image bytes → base64.
  Models: `ultra`, `core`, `sd3.5-large` (routes to `sd3` endpoint with `model` field).
- **Fal.ai** (image+video, async queue) — `Authorization: Key <key>`.
  `POST https://queue.fal.run/<model>` (`fal-ai/flux/dev`, `fal-ai/fast-sdxl`,
  video: `fal-ai/ltx-video`) with `{prompt, image_size:{width,height}, seed, ...}`; response
  `request_id`; poll `GET https://queue.fal.run/<model>/requests/<id>/status` until
  `COMPLETED`; then `GET .../requests/<id>` → `images[0].url` (or `video.url`) → download.
- **Replicate** (image+video, async) — `Authorization: Bearer <key>`, plus header
  `Prefer: wait=5` best-effort. `POST https://api.replicate.com/v1/models/<owner/name>/predictions`
  with `{input:{prompt, ...}}` (official-model route: no version hash to curate). Poll
  `GET /v1/predictions/<id>` until `succeeded`; `output` is URL or list of URLs → download
  first. Detect image vs video by URL extension. Models: `black-forest-labs/flux-dev`,
  `stability-ai/sdxl` (image), one video model (`minimax/video-01`).
- **Runway** (video, async) — `Authorization: Bearer <key>`, `X-Runway-Version: 2024-11-06`.
  `POST https://api.dev.runwayml.com/v1/image_to_video` when `job.initImage` present (data URL
  passed as `promptImage`), else `text_to_video`; body `{model, promptText, duration, ratio}`
  (map job aspect to nearest supported ratio). Response `id`; poll `GET /v1/tasks/<id>` until
  `SUCCEEDED`; download `output[0]` → base64 MP4. Models: `gen3a_turbo`, `gen4_turbo`.

## Bridge: `bridge/server.py` routes (edit)

Add `/cloud` to `API_PREFIXES`; three routes inside the pure `build_response()`:

- `GET /cloud/providers` → `[{id, label, kind, models, hasKey}]` (`hasKey` from settings.json;
  key values never returned).
- `POST /cloud/keys` body `{provider, key}` → validate provider id; persist under `cloudKeys`;
  empty/blank key deletes the entry (that's how a key is cleared). → `{"ok": true, "hasKey": bool}`.
- `POST /cloud/generate` body `{provider, model, jobId, ...RenderJob}` → look up provider, load
  key (missing → HTTP 400 with clear message), track progress via the existing `_JOB_ID` /
  `_write_progress` plumbing, call `provider.generate(...)`, return result JSON. On `CloudError`
  → HTTP 502 with `{"error": "<provider>: <message>"}` (mirrors how /generate surfaces worker
  errors; the adapter throws it loudly).

## Frontend: `src/bridge/cloudAdapter.ts` (new)

`CloudAdapter implements BackendAdapter` (ctor takes `fetchImpl` for tests, like HttpAdapter):

- `id: 'cloud'`, `label: 'Cloud (hosted APIs)'`; `setBaseUrl/setProvider/setModel`.
- `generate(job, onProgress)` → mint jobId, `POST /cloud/generate` with `{provider, model,
  jobId, ...job}` while polling `/progress/<jobId>` (same loop as httpAdapter, 1200ms timeout);
  convert `image_base64`/`video_base64` → dataUrl → `RenderResult`. A JSON `error` or non-2xx →
  thrown Error (the store already renders queue errors as a banner).
- `ping()` → `GET /cloud/providers` ok.
- `listProviders()` → typed `CloudProviderInfo[]` for the panel; `saveKey(provider, key)` →
  `POST /cloud/keys`.
- `listSvdModels()` → `[]`. `animateStill` / `evolveStep` / `renderMotion` → **throw** a clear
  Error: "not available on the Cloud backend — switch to the Local bridge". Never a fake.

## Frontend wiring

- `src/turboForge/backends/backendSettings.ts`: `RenderBackendId` adds `'cloud'`;
  `BackendSettings` adds `cloudProvider: string`, `cloudModel: string` (defaults `'openai'` /
  `''`); sanitize in the existing normalize function; `settingsBackendToTurboBackend('cloud')` →
  `'future-cloud'` (the id already reserved in `src/turboForge/types.ts` `BackendId`).
- `src/state/store.ts`: module-level `export const cloudAdapter = new CloudAdapter()`; resolver
  (~line 710) gains `if (settings.selectedBackend === 'cloud') { cloudAdapter.setBaseUrl(bridgeUrl);
  cloudAdapter.setProvider/setModel; return cloudAdapter; }`.
- `src/components/BackendSettingsPanel.tsx`: add a **Cloud** option to the backend `<select>`;
  when selected show: provider `<select>` (from `GET /cloud/providers`), model `<select>` (that
  provider's `models`), per-provider `<input type="password">` + Save button (POST /cloud/keys;
  input cleared after save; shows "key saved" state from `hasKey`). Key never enters the store.
- **Health**: reuse the existing `backendSettings.lastHealth` mechanism — pinging/selecting the
  cloud backend with `hasKey === false` for the chosen provider sets a warning health entry
  ("No API key saved for <provider>"); panel shows it inline like bridge health.
- **Manifest/provenance**: `ExportManifest.render` (src/core/manifest.ts:26) gains
  `cloudProvider?: string; cloudModel?: string`, populated when `selectedBackend === 'cloud'`.
- **UI gating (honesty)**: Gallery's SVD Animate panel, Evolve, and motion-clip rendering
  already read `backendSettings.selectedBackend` — when it is `'cloud'`, show the same kind of
  "switch to the Local bridge" hint used for mock, instead of firing a doomed call.

## Testing / verification

- **Python** (`bridge/test_cloud.py`): per provider, monkeypatch `_http_json`/`_http_bytes` with
  recorded sample payloads — assert request URL/headers/body and that the parser returns the
  result contract. One async-poll test (fake task `queued → running → succeeded`, asserts
  on_progress calls). CloudError on non-2xx and on poll timeout.
- **Python** (`bridge/test_server.py` additions): through pure `build_response()` —
  `/cloud/providers` shape (temp settings path via env), `/cloud/keys` persists + blank-key
  delete, `/cloud/generate` success (monkeypatched provider), missing-key 400, CloudError → 502.
- **TS** (`src/bridge/cloudAdapter.test.ts`): mocked fetch — result → dataUrl mapping (image +
  video), JSON error → throw, unsupported ops throw, saveKey/listProviders request shapes.
- **TS**: backendSettings normalize accepts/sanitizes `'cloud'`; store resolver returns
  cloudAdapter; versionSync stays green.
- **HONEST LIMIT (stated in the PR):** live provider calls require real paid API keys, absent in
  dev. Adapters are built and unit-tested against mocked responses; **live verification is the
  user's step with their own key.** The local pipeline stays the default backend.

## Acceptance

1. Backend → Cloud → pick provider + model + paste key → render returns the provider's
   image/video into the Gallery (verified live by the user with a key).
2. Runway/Replicate/Fal video → MP4 in the Gallery; Stability/OpenAI → images.
3. Missing key → clear health warning + clear error, never a silent placeholder.
4. SVD Animate / Evolve / motion clips on the Cloud backend → clear "switch to Local" guidance,
   never a fake result.
5. All existing local backends and tests remain green; version files bumped to 0.33.0 in
   lockstep.
