# Video Export Suite — design spec

**Date:** 2026-07-09
**Status:** Approved (brainstorming — "do the queued", Video & Motion depth first)
**Scope:** Extend motion-clip export from {mp4, gif} to add **WebM/VP9** and a
**frame-sequence (PNG zip)**. Out of scope (separate future spec): real temporal
coherence (AnimateDiff/SVD improvements — heavy model download + GPU), resolution
re-render, frame interpolation.

## Problem

Motion clips export only H.264 mp4 or animated GIF. WebM/VP9 is smaller and
browser-native (a better fit for the shareable Showcase), and creators who take a
clip into an external editor need the raw frames — neither is available today.

## Goal

`RenderMotionOptions.format` gains `'webm'` and `'frames'`:
- **webm** — VP9 / yuv420p, encoded by the same imageio-ffmpeg libvpx-vp9 path
  (verified available in the managed runtime). Lands in the Gallery like mp4/gif.
- **frames** — a ZIP of numbered PNGs (`frame_0001.png` …), built server-side with
  Python `zipfile`. It is a download artifact, NOT gallery media, so it bypasses
  the gallery and saves straight to disk.

## Architecture

### Encoder — `bridge/diffusers_backend.py` `_encode_sequence` (BOTH copies)

The in-`_WORKER_SOURCE` copy (what runs) and the module-level unit-tested mirror.
Add two branches ahead of the gif fallback:

- `fmt == 'webm'`: mirror the mp4 branch but `codec='libvpx-vp9'`,
  `ffmpeg_params=['-b:v','0','-crf','32','-movflags','+faststart']` (constant-
  quality VP9), even-dimension pad (yuv420p), temp `.webm`. Returns
  `{video_base64, mediaType:'video', mimeType:'video/webm', extension:'webm'}`. On
  any failure → GIF fallback (same loud pattern as mp4).
- `fmt == 'frames'`: `zipfile.ZipFile(BytesIO, 'w', ZIP_DEFLATED)`; write each RGB
  frame as `frame_%04d.png` via `PIL Image.save`. Returns
  `{video_base64: <zip b64>, mediaType:'archive', mimeType:'application/zip',
  extension:'zip'}`. (`video_base64` carries the payload — no response-schema
  change. Never a `<video>`.)

`mp4`/`gif` branches unchanged. `_encode_sequence(fmt)` default stays `'mp4'`.

### Adapter — `src/bridge/adapter.ts`

`RenderMotionOptions.format: 'mp4' | 'gif' | 'webm' | 'frames'`. `httpAdapter` and
`mockAdapter` already thread `format` to the bridge and read
`mediaType`/`mimeType`/`extension` back verbatim, so webm/zip flow through with no
per-format code. `mockAdapter` returns a small valid zip for `frames` and a tiny
webm-shaped payload for `webm` so the mock path stays honest.

### Store — `src/state/store.ts` `renderActiveMotionClip`

Branch on the result: **archive** (`extension === 'zip'` / `mediaType ===
'archive'`) → `downloadDataUrl(result.dataUrl, `${slug}.frames.zip`)` and set a
status ("Exported N frames → …zip"); it does NOT enter the gallery. `mp4`/`gif`/
`webm` → the existing gallery path, with `manifest.media.format` reflecting the
real extension.

### UI — `src/components/motion/MotionTimeline.tsx`

The render-format control gains **WebM** and **Frames (ZIP)** options
(`renderFormat` type widened). Frames shows a hint that it downloads a zip rather
than landing in the gallery.

## Data flow

```
MotionTimeline (format) → renderActiveMotionClip → adapter.renderMotion(jobs,{format})
    → bridge do_render_sequence → _encode_sequence(frames, fps, fmt)
        fmt webm  → VP9 base64  → RenderResult{video/webm} → Gallery
        fmt frames→ zip base64  → RenderResult{application/zip} → downloadDataUrl (no gallery)
        fmt mp4/gif→ (unchanged) → Gallery
```

## Error handling

- webm encode failure → loud GIF fallback (same as mp4; `render.fallback` set).
- frames with zero frames → the existing `_encode_sequence` zero-frames guard
  throws (loud), surfaced as a fallback like today.
- Unknown/unsupported format from an old client → default `'mp4'`.
- No silent placeholders (project rule).

## Testing

`bridge/test_motion_render.py` (pure, mock the encoders like the existing tests):
- `webm` branch returns `video/webm` + `extension webm`; real-encoder integration
  test (skipped if imageio-ffmpeg absent) asserts EBML magic `1A 45 DF A3`.
- `frames` returns `application/zip`; decoding the base64 yields a valid zip whose
  namelist has N `frame_%04d.png` entries.
- webm encoder failure → GIF fallback; `frames` never touches the video encoder.

`tests/*.ts`:
- adapter/store routing: a `frames`/zip result triggers a download and is NOT added
  to the gallery; a `webm` result lands in the gallery with `format: 'webm'`.

## Rollout

Single PR: encoder (both copies) + adapter type + store routing + UI + tests.
Additive, no flag. Version bump to **0.23.0**.

## Out of scope (tracked)

- Temporal coherence (AnimateDiff/SVD upgrade) — heavy, its own spec.
- Frame interpolation, resolution presets, audio-track muxing.
- **Hosted share-links** (the other queued sub-project) — its own spec next.
