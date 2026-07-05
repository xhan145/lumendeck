# LumenDeck — Cloud Provider APIs (2026-07-04, scheduled AFTER the v0.6 local roadmap)

Add hosted generation backends (Runway, Replicate, Fal.ai, Stability, OpenAI) alongside the
local Mock / ComfyUI / Diffusers-bridge adapters. Approved via brainstorming; build order:
**after** img2img/inpainting, ControlNet, upscaling, batch.

## Architecture — cloud calls go through the bridge
The bridge (not the browser) makes provider API calls, so keys never touch web content and
there is no CORS. Keys persist in `%LOCALAPPDATA%\LumenDeck\settings.json` under `cloudKeys`.

- `bridge/cloud.py`: a `CloudProvider` ABC — `id`, `label`, `kind` (image|video|both),
  `models()`, `generate(job, key, on_progress) -> {image_base64|video_base64|url, mediaType,
  mimeType, extension}`. One subclass per provider. Async providers (video) submit → poll →
  return; polling maps onto the existing progress-file mechanism.
- Server routes: `GET /cloud/providers` (list + which have keys), `POST /cloud/keys`
  (persist a provider key), `POST /cloud/generate` (body: provider, model, + RenderJob fields).
  Reuse `_JOB_ID`/progress plumbing; never a silent failure (loud error with provider message).

### Providers
- **Runway** — Gen-3/Gen-4 video. `POST` a task to the Runway API, poll the task id, download
  the resulting MP4 → base64. Image→video and text→video. Async.
- **Replicate** — `POST /v1/predictions` (model version + input), poll `get` until succeeded,
  fetch output URL(s). Covers hundreds of image + video models. Async.
- **Fal.ai** — queue submit + poll (`fal-ai/*` endpoints), fetch result URL. Fast image/video.
- **Stability AI** — `/v2beta/stable-image/generate/*` (SD3/SDXL/core). Mostly sync, returns
  image bytes.
- **OpenAI** — `/v1/images/generations` (gpt-image-1 / dall-e-3). Sync, returns b64/url.

## Frontend
- `src/bridge/cloudAdapter.ts` implements `BackendAdapter`, posting to `/cloud/generate` with
  the selected provider+model; parses image/video results (Gallery already renders `<video>`
  for `video/*`).
- Backend panel: a **Cloud** backend option → provider dropdown, per-provider API-key input
  (saved via `/cloud/keys`), and a model picker fed by `providers()`.
- `backendSettings`: add `cloudProvider`, `cloudModel`; keys are bridge-side (not persisted in
  the browser).
- Manifest: record `{ backend:'cloud', provider, model }`. Health: warn when the selected
  provider has no key.

## Testing / verification
- Unit: request-builder + response-parser per provider against **mocked** HTTP (recorded
  sample payloads); key presence/health logic; async poll loop with a fake task that
  transitions queued→succeeded.
- **Honest limit:** live calls need real paid API keys, which aren't available in dev — the
  adapters are built and unit-tested against mocked responses; live verification is the user's
  step with their own key. The local pipeline stays the default.

## Acceptance
1. Backend → Cloud → pick provider + model + paste key → render returns the provider's
   image/video into the gallery (verified live by the user with a key).
2. Runway/Replicate/Fal video returns MP4 shown in the gallery; Stability/OpenAI return images.
3. Missing key → clear health warning, never a silent placeholder.
4. Existing local backends and all tests remain green.
