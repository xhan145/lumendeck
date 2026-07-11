# Cloud Provider Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five hosted generation backends (OpenAI, Stability AI, Fal.ai, Replicate, Runway) behind a new `cloud` backend option, with all provider HTTP calls made by the Python bridge and API keys stored bridge-side only.

**Architecture:** A new stdlib-only `bridge/cloud.py` provider layer + three `/cloud/*` routes in `bridge/server.py`; a `CloudAdapter` implementing the full `BackendAdapter` interface (generate real, SVD/evolve/motion loudly unsupported); settings/store/panel wiring in the React app. Result contract matches the local worker so the Gallery renders results unchanged.

**Tech Stack:** Python 3 stdlib (`urllib.request`, `json`, `base64`, `time`), TypeScript/React 18, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-cloud-providers-design.md`

## Global Constraints

- Bridge stays **pure stdlib** — no `requests`, no pip deps (PyInstaller sidecar).
- API keys live ONLY in `%LOCALAPPDATA%\LumenDeck\settings.json` under `cloudKeys` — never in Zustand/localStorage, never returned by any route.
- Result contract: `{"image_base64": ...}` or `{"video_base64": ..., "mediaType": "video", "mimeType": "video/mp4", "extension": "mp4"}` — raw base64, no `data:` prefix.
- **Never a silent failure**: every provider error surfaces as `CloudError` → HTTP 502 with the provider's message → thrown in the adapter → visible banner.
- Version lockstep 0.33.0: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (versionSync test enforces; `APP_VERSION` derives from package.json via Vite define — do NOT hardcode).
- Python test files are dual-mode: pytest-style `assert` functions PLUS an `if __name__ == "__main__":` block calling each test (repo convention — see `bridge/test_server.py`).
- Zustand rule: never `useStudio((s) => s.someGetter())` returning a fresh object; subscribe to reactive slices.
- All work on branch `feature/cloud-providers`; land via PR (direct pushes to main are blocked).
- HONEST LIMIT: live provider calls need real paid keys (absent in dev). Unit tests run against mocked HTTP; the PR must state that live verification is the user's step.

---

### Task 1: `bridge/cloud.py` — provider layer + mocked-HTTP tests

**Files:**
- Create: `bridge/cloud.py`
- Create: `bridge/test_cloud.py`

**Interfaces:**
- Produces: `CloudError(provider, message)` exception; `CloudProvider` base (attrs `id`, `label`, `kind`; methods `models()`, `generate(job: dict, model: str, key: str, on_progress) -> dict`); `PROVIDERS: dict[str, CloudProvider]` with ids `openai|stability|fal|replicate|runway`; `provider_listing(keys: dict) -> list[dict]` (each `{id,label,kind,models,hasKey}`). Module-level `_http_json(provider, url, method, headers, body, timeout)`, `_http_bytes(provider, url, headers, body, method, timeout)`, `_sleep`, `_monotonic` (all monkeypatchable).
- Consumes: nothing from this repo (standalone module).

- [ ] **Step 1: Write the failing tests** — `bridge/test_cloud.py`:

```python
"""Mocked-HTTP unit tests for the cloud provider layer (no network)."""
import base64
import json

import cloud
from cloud import CloudError, PROVIDERS, provider_listing


class JsonRecorder:
    """Scripted stand-in for cloud._http_json; records every call."""

    def __init__(self, responses):
        self.calls = []
        self.responses = list(responses)

    def __call__(self, provider, url, method="GET", headers=None, body=None, timeout=120):
        self.calls.append({
            "provider": provider, "url": url, "method": method,
            "headers": dict(headers or {}), "body": body,
        })
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class BytesRecorder:
    def __init__(self, payload=b"BYTES"):
        self.calls = []
        self.payload = payload

    def __call__(self, provider, url, headers=None, body=None, method="GET", timeout=300):
        self.calls.append({"provider": provider, "url": url, "method": method,
                           "headers": dict(headers or {}), "body": body})
        return self.payload


def _job(**over):
    job = {"prompt": "a neon cat", "resolvedPrompt": "a neon cat", "negativePrompt": "",
           "seed": 7, "width": 1024, "height": 1024}
    job.update(over)
    return job


def _patched(json_stub=None, bytes_stub=None):
    """Swap the module HTTP helpers; return the originals for finally-restore."""
    originals = (cloud._http_json, cloud._http_bytes, cloud._sleep)
    if json_stub is not None:
        cloud._http_json = json_stub
    if bytes_stub is not None:
        cloud._http_bytes = bytes_stub
    cloud._sleep = lambda s: None
    return originals


def _restore(originals):
    cloud._http_json, cloud._http_bytes, cloud._sleep = originals


def test_provider_listing_reports_ids_models_and_haskey():
    listing = provider_listing({"openai": "sk-x", "runway": "  "})
    ids = {p["id"] for p in listing}
    assert ids == {"openai", "stability", "fal", "replicate", "runway"}
    by_id = {p["id"]: p for p in listing}
    assert by_id["openai"]["hasKey"] is True
    assert by_id["runway"]["hasKey"] is False  # blank key = no key
    for p in listing:
        assert p["models"], f"{p['id']} must curate at least one model"
        for m in p["models"]:
            assert set(m) == {"id", "label", "kind"}


def test_openai_builds_request_and_parses_b64():
    png_b64 = base64.b64encode(b"PNG").decode("ascii")
    stub = JsonRecorder([{"data": [{"b64_json": png_b64}]}])
    originals = _patched(json_stub=stub)
    try:
        result = PROVIDERS["openai"].generate(_job(), "gpt-image-1", "sk-test", lambda p: None)
    finally:
        _restore(originals)
    call = stub.calls[0]
    assert call["url"] == "https://api.openai.com/v1/images/generations"
    assert call["method"] == "POST"
    assert call["headers"]["Authorization"] == "Bearer sk-test"
    assert call["body"]["model"] == "gpt-image-1"
    assert call["body"]["prompt"] == "a neon cat"
    assert call["body"]["size"] == "1024x1024"
    assert result["image_base64"] == png_b64
    assert result["mediaType"] == "image"


def test_openai_size_mapping_by_aspect_and_model():
    assert cloud._openai_size(1536, 640, "gpt-image-1") == "1536x1024"
    assert cloud._openai_size(640, 1536, "gpt-image-1") == "1024x1536"
    assert cloud._openai_size(1536, 640, "dall-e-3") == "1792x1024"
    assert cloud._openai_size(640, 1536, "dall-e-3") == "1024x1792"
    assert cloud._openai_size(1024, 1024, "dall-e-3") == "1024x1024"


def test_stability_multipart_returns_image_bytes():
    stub = BytesRecorder(b"STABLEPNG")
    originals = _patched(bytes_stub=stub)
    try:
        result = PROVIDERS["stability"].generate(
            _job(negativePrompt="blurry", width=1536, height=640), "core", "sk-stab", lambda p: None)
    finally:
        _restore(originals)
    call = stub.calls[0]
    assert call["url"] == "https://api.stability.ai/v2beta/stable-image/generate/core"
    assert call["method"] == "POST"
    assert call["headers"]["Authorization"] == "Bearer sk-stab"
    assert call["headers"]["Accept"] == "image/*"
    assert call["headers"]["Content-Type"].startswith("multipart/form-data; boundary=")
    assert b'name="prompt"' in call["body"] and b"a neon cat" in call["body"]
    assert b'name="negative_prompt"' in call["body"] and b"blurry" in call["body"]
    assert b'name="aspect_ratio"' in call["body"]
    assert result["image_base64"] == base64.b64encode(b"STABLEPNG").decode("ascii")


def test_stability_sd3_routes_to_sd3_endpoint_with_model_field():
    stub = BytesRecorder()
    originals = _patched(bytes_stub=stub)
    try:
        PROVIDERS["stability"].generate(_job(), "sd3.5-large", "k", lambda p: None)
    finally:
        _restore(originals)
    assert stub.calls[0]["url"].endswith("/generate/sd3")
    assert b'name="model"' in stub.calls[0]["body"] and b"sd3.5-large" in stub.calls[0]["body"]


def test_stability_aspect_picks_nearest_supported_ratio():
    assert cloud._stability_aspect(1024, 1024) == "1:1"
    assert cloud._stability_aspect(1920, 1080) == "16:9"
    assert cloud._stability_aspect(832, 1216) == "2:3"


def test_fal_polls_queue_until_completed_and_reports_progress():
    stub = JsonRecorder([
        {"request_id": "r1"},
        {"status": "IN_QUEUE"},
        {"status": "IN_PROGRESS"},
        {"status": "COMPLETED"},
        {"images": [{"url": "https://cdn.fal/x.png"}]},
    ])
    bytes_stub = BytesRecorder(b"FALIMG")
    phases = []
    originals = _patched(json_stub=stub, bytes_stub=bytes_stub)
    try:
        result = PROVIDERS["fal"].generate(
            _job(), "fal-ai/fast-sdxl", "fal-key", lambda p: phases.append(p["phase"]))
    finally:
        _restore(originals)
    assert stub.calls[0]["url"] == "https://queue.fal.run/fal-ai/fast-sdxl"
    assert stub.calls[0]["headers"]["Authorization"] == "Key fal-key"
    assert stub.calls[0]["body"]["image_size"] == {"width": 1024, "height": 1024}
    assert stub.calls[1]["url"].endswith("/requests/r1/status")
    assert stub.calls[4]["url"].endswith("/requests/r1")
    assert "queued" in phases and "running" in phases
    assert result["image_base64"] == base64.b64encode(b"FALIMG").decode("ascii")


def test_fal_video_model_returns_video_contract():
    stub = JsonRecorder([
        {"request_id": "r2"},
        {"status": "COMPLETED"},
        {"video": {"url": "https://cdn.fal/clip.mp4"}},
    ])
    originals = _patched(json_stub=stub, bytes_stub=BytesRecorder(b"MP4"))
    try:
        result = PROVIDERS["fal"].generate(_job(), "fal-ai/ltx-video", "k", lambda p: None)
    finally:
        _restore(originals)
    assert result["video_base64"] == base64.b64encode(b"MP4").decode("ascii")
    assert result["mediaType"] == "video" and result["mimeType"] == "video/mp4" and result["extension"] == "mp4"


def test_fal_failed_status_raises_cloud_error():
    stub = JsonRecorder([{"request_id": "r3"}, {"status": "FAILED", "error": "boom"}])
    originals = _patched(json_stub=stub)
    try:
        try:
            PROVIDERS["fal"].generate(_job(), "fal-ai/fast-sdxl", "k", lambda p: None)
            assert False, "expected CloudError"
        except CloudError as exc:
            assert "failed" in str(exc).lower()
    finally:
        _restore(originals)


def test_replicate_official_model_route_and_curated_inputs():
    stub = JsonRecorder([
        {"id": "p1", "status": "processing"},
        {"status": "succeeded", "output": ["https://cdn.rep/out.png"]},
    ])
    originals = _patched(json_stub=stub, bytes_stub=BytesRecorder(b"REP"))
    try:
        result = PROVIDERS["replicate"].generate(
            _job(negativePrompt="ugly"), "stability-ai/sdxl", "r8-key", lambda p: None)
    finally:
        _restore(originals)
    create = stub.calls[0]
    assert create["url"] == "https://api.replicate.com/v1/models/stability-ai/sdxl/predictions"
    assert create["headers"]["Authorization"] == "Bearer r8-key"
    assert create["body"]["input"]["prompt"] == "a neon cat"
    assert create["body"]["input"]["negative_prompt"] == "ugly"
    assert create["body"]["input"]["seed"] == 7
    assert stub.calls[1]["url"] == "https://api.replicate.com/v1/predictions/p1"
    assert result["image_base64"] == base64.b64encode(b"REP").decode("ascii")


def test_replicate_flux_omits_unsupported_inputs():
    stub = JsonRecorder([{"id": "p2", "status": "succeeded", "output": "https://cdn.rep/one.png"}])
    originals = _patched(json_stub=stub, bytes_stub=BytesRecorder(b"F"))
    try:
        PROVIDERS["replicate"].generate(_job(negativePrompt="ugly"), "black-forest-labs/flux-dev", "k", lambda p: None)
    finally:
        _restore(originals)
    inputs = stub.calls[0]["body"]["input"]
    assert "negative_prompt" not in inputs and "width" not in inputs
    assert inputs["seed"] == 7


def test_replicate_failed_prediction_raises():
    stub = JsonRecorder([
        {"id": "p3", "status": "processing"},
        {"status": "failed", "error": "NSFW content"},
    ])
    originals = _patched(json_stub=stub)
    try:
        try:
            PROVIDERS["replicate"].generate(_job(), "stability-ai/sdxl", "k", lambda p: None)
            assert False, "expected CloudError"
        except CloudError as exc:
            assert "NSFW" in str(exc)
    finally:
        _restore(originals)


def test_runway_image_to_video_uses_prompt_image_and_polls():
    stub = JsonRecorder([
        {"id": "t1"},
        {"status": "PENDING"},
        {"status": "RUNNING"},
        {"status": "SUCCEEDED", "output": ["https://cdn.run/v.mp4"]},
    ])
    phases = []
    originals = _patched(json_stub=stub, bytes_stub=BytesRecorder(b"RUNMP4"))
    try:
        result = PROVIDERS["runway"].generate(
            _job(initImage="data:image/png;base64,QUJD", width=1280, height=720),
            "gen4_turbo", "rw-key", lambda p: phases.append(p["phase"]))
    finally:
        _restore(originals)
    create = stub.calls[0]
    assert create["url"] == "https://api.dev.runwayml.com/v1/image_to_video"
    assert create["headers"]["Authorization"] == "Bearer rw-key"
    assert create["headers"]["X-Runway-Version"] == "2024-11-06"
    assert create["body"]["promptImage"] == "data:image/png;base64,QUJD"
    assert create["body"]["ratio"] == "1280:720"
    assert stub.calls[1]["url"] == "https://api.dev.runwayml.com/v1/tasks/t1"
    assert "queued" in phases and "running" in phases
    assert result["video_base64"] == base64.b64encode(b"RUNMP4").decode("ascii")
    assert result["mimeType"] == "video/mp4"


def test_runway_text_to_video_without_init_image():
    stub = JsonRecorder([{"id": "t2"}, {"status": "SUCCEEDED", "output": ["https://cdn.run/v2.mp4"]}])
    originals = _patched(json_stub=stub, bytes_stub=BytesRecorder(b"V"))
    try:
        PROVIDERS["runway"].generate(_job(width=720, height=1280), "gen3a_turbo", "k", lambda p: None)
    finally:
        _restore(originals)
    assert stub.calls[0]["url"] == "https://api.dev.runwayml.com/v1/text_to_video"
    assert stub.calls[0]["body"]["ratio"] == "768:1280"


def test_poll_timeout_raises_cloud_error():
    stub = JsonRecorder([{"request_id": "r9"}] + [{"status": "IN_QUEUE"}] * 50)
    ticks = {"now": 0.0}

    def fake_monotonic():
        ticks["now"] += 200.0
        return ticks["now"]

    originals = _patched(json_stub=stub)
    original_monotonic = cloud._monotonic
    cloud._monotonic = fake_monotonic
    try:
        try:
            PROVIDERS["fal"].generate(_job(), "fal-ai/fast-sdxl", "k", lambda p: None)
            assert False, "expected timeout CloudError"
        except CloudError as exc:
            assert "timed out" in str(exc)
    finally:
        cloud._monotonic = original_monotonic
        _restore(originals)


def test_http_helper_error_propagates_as_cloud_error():
    stub = JsonRecorder([CloudError("openai", "HTTP 401: invalid api key")])
    originals = _patched(json_stub=stub)
    try:
        try:
            PROVIDERS["openai"].generate(_job(), "gpt-image-1", "bad", lambda p: None)
            assert False, "expected CloudError"
        except CloudError as exc:
            assert "401" in str(exc)
    finally:
        _restore(originals)


if __name__ == "__main__":
    test_provider_listing_reports_ids_models_and_haskey()
    test_openai_builds_request_and_parses_b64()
    test_openai_size_mapping_by_aspect_and_model()
    test_stability_multipart_returns_image_bytes()
    test_stability_sd3_routes_to_sd3_endpoint_with_model_field()
    test_stability_aspect_picks_nearest_supported_ratio()
    test_fal_polls_queue_until_completed_and_reports_progress()
    test_fal_video_model_returns_video_contract()
    test_fal_failed_status_raises_cloud_error()
    test_replicate_official_model_route_and_curated_inputs()
    test_replicate_flux_omits_unsupported_inputs()
    test_replicate_failed_prediction_raises()
    test_runway_image_to_video_uses_prompt_image_and_polls()
    test_runway_text_to_video_without_init_image()
    test_poll_timeout_raises_cloud_error()
    test_http_helper_error_propagates_as_cloud_error()
    print("bridge cloud: all checks passed")
```

- [ ] **Step 2: Run to verify failure** — `python bridge/test_cloud.py` from `bridge/`. Expected: `ModuleNotFoundError: No module named 'cloud'`.

- [ ] **Step 3: Write `bridge/cloud.py`**:

```python
"""Cloud provider layer for the LumenDeck bridge (PURE STDLIB — PyInstaller-frozen).

Each provider turns one LumenDeck RenderJob (dict) into a hosted-API call and
returns the SAME result contract as the local worker, so the frontend/Gallery
handle cloud results unchanged:

    {"image_base64": "<raw b64>", "seed": "<str>", "mediaType": "image", ...}
    {"video_base64": "<raw b64>", "mediaType": "video", "mimeType": "video/mp4",
     "extension": "mp4", "seed": "<str>"}

Keys are loaded by server.py from settings.json and passed in per call; this
module never reads or writes them. Async providers submit -> poll -> download,
reporting on_progress({"phase": "queued"|"running", "progress": p}) each poll.
Every failure raises CloudError — NEVER a silent fallback.
"""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request

IMAGE_DEADLINE_S = 180
VIDEO_DEADLINE_S = 600
POLL_INTERVAL_S = 2.0

# Test seams: tests monkeypatch these module attributes (the providers always
# call them through the module namespace so patches take effect).
_sleep = time.sleep
_monotonic = time.monotonic


class CloudError(Exception):
    """A loud provider failure carrying the provider id + its error message."""

    def __init__(self, provider: str, message: str):
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message


def _http_json(provider, url, method="GET", headers=None, body=None, timeout=120):
    """HTTP request returning parsed JSON. dict/list bodies are JSON-encoded."""
    data = None
    req_headers = dict(headers or {})
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/json")
        else:
            data = body
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise CloudError(provider, f"HTTP {exc.code}: {detail or exc.reason}")
    except urllib.error.URLError as exc:
        raise CloudError(provider, f"network error: {exc.reason}")
    except json.JSONDecodeError as exc:
        raise CloudError(provider, f"non-JSON response: {exc}")


def _http_bytes(provider, url, headers=None, body=None, method="GET", timeout=300):
    """HTTP request returning raw bytes (result downloads, Stability images)."""
    req = urllib.request.Request(url, data=body, headers=dict(headers or {}), method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise CloudError(provider, f"HTTP {exc.code}: {detail or exc.reason}")
    except urllib.error.URLError as exc:
        raise CloudError(provider, f"network error: {exc.reason}")


def _prompt_of(job):
    return str(job.get("resolvedPrompt") or job.get("prompt") or "")


def _multipart(fields):
    """Hand-rolled multipart/form-data (text fields only). Returns (body, content_type)."""
    boundary = "lumendeck-cloud-7f2a9c1b"
    parts = []
    for name, value in fields.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        parts.append(str(value).encode("utf-8"))
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _poll_progress(started, deadline):
    """Map elapsed poll time onto a 0.1..0.9 progress ramp (advisory)."""
    elapsed = _monotonic() - started
    return min(0.9, 0.1 + 0.8 * (elapsed / max(1.0, deadline)))


def _image_result(provider_id, url, headers, job):
    raw = _http_bytes(provider_id, url, headers=headers)
    clean = url.split("?")[0].lower()
    mime = "image/jpeg" if clean.endswith((".jpg", ".jpeg")) else "image/png"
    ext = "jpg" if mime == "image/jpeg" else "png"
    return {"image_base64": base64.b64encode(raw).decode("ascii"),
            "seed": str(job.get("seed", -1)), "mediaType": "image",
            "mimeType": mime, "extension": ext}


def _video_result(provider_id, url, headers, job):
    raw = _http_bytes(provider_id, url, headers=headers)
    return {"video_base64": base64.b64encode(raw).decode("ascii"),
            "mediaType": "video", "mimeType": "video/mp4", "extension": "mp4",
            "seed": str(job.get("seed", -1))}


class CloudProvider:
    """One hosted generation service. Subclasses fill id/label/kind + methods."""

    id = ""
    label = ""
    kind = "image"  # 'image' | 'video' | 'both'

    def models(self):
        raise NotImplementedError

    def generate(self, job, model, key, on_progress):
        raise NotImplementedError

    def _model_kind(self, model):
        for entry in self.models():
            if entry["id"] == model:
                return entry["kind"]
        return "image"


def _openai_size(width, height, model):
    """Nearest supported size string for the model, chosen by aspect."""
    if model == "dall-e-3":
        wide, tall = "1792x1024", "1024x1792"
    else:  # gpt-image-1
        wide, tall = "1536x1024", "1024x1536"
    if width > height:
        return wide
    if height > width:
        return tall
    return "1024x1024"


class OpenAIProvider(CloudProvider):
    id = "openai"
    label = "OpenAI Images"
    kind = "image"

    def models(self):
        return [
            {"id": "gpt-image-1", "label": "GPT Image 1", "kind": "image"},
            {"id": "dall-e-3", "label": "DALL-E 3", "kind": "image"},
        ]

    def generate(self, job, model, key, on_progress):
        on_progress({"phase": "running", "progress": 0.2})
        body = {"model": model, "prompt": _prompt_of(job),
                "size": _openai_size(int(job.get("width", 1024)), int(job.get("height", 1024)), model),
                "n": 1}
        data = _http_json(self.id, "https://api.openai.com/v1/images/generations",
                          method="POST", headers={"Authorization": f"Bearer {key}"},
                          body=body, timeout=IMAGE_DEADLINE_S)
        items = data.get("data") or []
        if not items:
            raise CloudError(self.id, f"no image in response: {json.dumps(data)[:200]}")
        first = items[0]
        if first.get("b64_json"):
            image_b64 = first["b64_json"]
        elif first.get("url"):
            image_b64 = base64.b64encode(_http_bytes(self.id, first["url"])).decode("ascii")
        else:
            raise CloudError(self.id, "response contained neither b64_json nor url")
        return {"image_base64": image_b64, "seed": str(job.get("seed", -1)),
                "mediaType": "image", "mimeType": "image/png", "extension": "png"}


_STABILITY_RATIOS = (
    ("21:9", 21 / 9), ("16:9", 16 / 9), ("3:2", 3 / 2), ("5:4", 5 / 4), ("1:1", 1.0),
    ("4:5", 4 / 5), ("2:3", 2 / 3), ("9:16", 9 / 16), ("9:21", 9 / 21),
)


def _stability_aspect(width, height):
    ratio = width / max(1, height)
    return min(_STABILITY_RATIOS, key=lambda item: abs(item[1] - ratio))[0]


class StabilityProvider(CloudProvider):
    id = "stability"
    label = "Stability AI"
    kind = "image"

    def models(self):
        return [
            {"id": "ultra", "label": "Stable Image Ultra", "kind": "image"},
            {"id": "core", "label": "Stable Image Core", "kind": "image"},
            {"id": "sd3.5-large", "label": "SD 3.5 Large", "kind": "image"},
        ]

    def generate(self, job, model, key, on_progress):
        on_progress({"phase": "running", "progress": 0.2})
        endpoint = "sd3" if model.startswith("sd3") else model
        fields = {"prompt": _prompt_of(job), "output_format": "png",
                  "aspect_ratio": _stability_aspect(int(job.get("width", 1024)), int(job.get("height", 1024)))}
        if job.get("negativePrompt"):
            fields["negative_prompt"] = str(job["negativePrompt"])
        seed = int(job.get("seed", -1))
        if seed >= 0:
            fields["seed"] = seed
        if endpoint == "sd3":
            fields["model"] = model
        body, content_type = _multipart(fields)
        raw = _http_bytes(self.id,
                          f"https://api.stability.ai/v2beta/stable-image/generate/{endpoint}",
                          headers={"Authorization": f"Bearer {key}", "Accept": "image/*",
                                   "Content-Type": content_type},
                          body=body, method="POST", timeout=IMAGE_DEADLINE_S)
        return {"image_base64": base64.b64encode(raw).decode("ascii"), "seed": str(seed),
                "mediaType": "image", "mimeType": "image/png", "extension": "png"}


class FalProvider(CloudProvider):
    id = "fal"
    label = "Fal.ai"
    kind = "both"

    def models(self):
        return [
            {"id": "fal-ai/flux/dev", "label": "FLUX.1 dev", "kind": "image"},
            {"id": "fal-ai/fast-sdxl", "label": "Fast SDXL", "kind": "image"},
            {"id": "fal-ai/ltx-video", "label": "LTX Video", "kind": "video"},
        ]

    def generate(self, job, model, key, on_progress):
        headers = {"Authorization": f"Key {key}"}
        is_video = self._model_kind(model) == "video"
        payload = {"prompt": _prompt_of(job)}
        if not is_video:
            payload["image_size"] = {"width": int(job.get("width", 1024)),
                                     "height": int(job.get("height", 1024))}
            seed = int(job.get("seed", -1))
            if seed >= 0:
                payload["seed"] = seed
            if job.get("negativePrompt"):
                payload["negative_prompt"] = str(job["negativePrompt"])
        submitted = _http_json(self.id, f"https://queue.fal.run/{model}", method="POST",
                               headers=headers, body=payload)
        request_id = submitted.get("request_id")
        if not request_id:
            raise CloudError(self.id, f"queue submit returned no request_id: {json.dumps(submitted)[:200]}")
        deadline = VIDEO_DEADLINE_S if is_video else IMAGE_DEADLINE_S
        base_url = f"https://queue.fal.run/{model}/requests/{request_id}"
        started = _monotonic()
        while True:
            status = _http_json(self.id, f"{base_url}/status", headers=headers)
            state = str(status.get("status", ""))
            if state == "COMPLETED":
                break
            if state in ("FAILED", "ERROR", "CANCELLED"):
                raise CloudError(self.id, f"request failed ({state}): {json.dumps(status)[:200]}")
            on_progress({"phase": "queued" if state == "IN_QUEUE" else "running",
                         "progress": _poll_progress(started, deadline)})
            if _monotonic() - started > deadline:
                raise CloudError(self.id, f"timed out after {deadline}s waiting for the queue")
            _sleep(POLL_INTERVAL_S)
        result = _http_json(self.id, base_url, headers=headers)
        if is_video:
            url = (result.get("video") or {}).get("url")
            if not url:
                raise CloudError(self.id, f"no video url in result: {json.dumps(result)[:200]}")
            return _video_result(self.id, url, headers, job)
        images = result.get("images") or []
        url = images[0].get("url") if images else None
        if not url:
            raise CloudError(self.id, f"no image url in result: {json.dumps(result)[:200]}")
        return _image_result(self.id, url, headers, job)


# Extra inputs each curated Replicate model accepts beyond `prompt` (Replicate
# rejects unknown input keys with a 422, so this list is deliberately per-model).
_REPLICATE_EXTRAS = {
    "black-forest-labs/flux-dev": ("seed",),
    "stability-ai/sdxl": ("seed", "negative_prompt", "width", "height"),
    "minimax/video-01": (),
}


class ReplicateProvider(CloudProvider):
    id = "replicate"
    label = "Replicate"
    kind = "both"

    def models(self):
        return [
            {"id": "black-forest-labs/flux-dev", "label": "FLUX.1 dev", "kind": "image"},
            {"id": "stability-ai/sdxl", "label": "SDXL", "kind": "image"},
            {"id": "minimax/video-01", "label": "MiniMax Video-01", "kind": "video"},
        ]

    def generate(self, job, model, key, on_progress):
        headers = {"Authorization": f"Bearer {key}", "Prefer": "wait=5"}
        is_video = self._model_kind(model) == "video"
        extras = _REPLICATE_EXTRAS.get(model, ())
        inputs = {"prompt": _prompt_of(job)}
        seed = int(job.get("seed", -1))
        if "seed" in extras and seed >= 0:
            inputs["seed"] = seed
        if "negative_prompt" in extras and job.get("negativePrompt"):
            inputs["negative_prompt"] = str(job["negativePrompt"])
        if "width" in extras:
            inputs["width"] = int(job.get("width", 1024))
            inputs["height"] = int(job.get("height", 1024))
        created = _http_json(self.id, f"https://api.replicate.com/v1/models/{model}/predictions",
                             method="POST", headers=headers, body={"input": inputs})
        prediction_id = created.get("id")
        if not prediction_id:
            raise CloudError(self.id, f"no prediction id in response: {json.dumps(created)[:200]}")
        deadline = VIDEO_DEADLINE_S if is_video else IMAGE_DEADLINE_S
        started = _monotonic()
        info = created
        while True:
            state = str(info.get("status", ""))
            if state == "succeeded":
                break
            if state in ("failed", "canceled"):
                raise CloudError(self.id, f"prediction {state}: {info.get('error') or json.dumps(info)[:200]}")
            on_progress({"phase": "queued" if state == "starting" else "running",
                         "progress": _poll_progress(started, deadline)})
            if _monotonic() - started > deadline:
                raise CloudError(self.id, f"timed out after {deadline}s waiting for the prediction")
            _sleep(POLL_INTERVAL_S)
            info = _http_json(self.id, f"https://api.replicate.com/v1/predictions/{prediction_id}",
                              headers={"Authorization": f"Bearer {key}"})
        output = info.get("output")
        url = output[0] if isinstance(output, list) and output else output
        if not isinstance(url, str) or not url:
            raise CloudError(self.id, f"no output url in prediction: {json.dumps(info)[:200]}")
        if url.split("?")[0].lower().endswith((".mp4", ".webm")) or is_video:
            return _video_result(self.id, url, {}, job)
        return _image_result(self.id, url, {}, job)


def _runway_ratio(width, height, model):
    """Nearest supported ratio string per model family."""
    if model == "gen3a_turbo":
        return "1280:768" if width >= height else "768:1280"
    if width == height:
        return "960:960"
    return "1280:720" if width > height else "720:1280"


def _as_data_url(image):
    return image if image.startswith("data:") else f"data:image/png;base64,{image}"


class RunwayProvider(CloudProvider):
    id = "runway"
    label = "Runway"
    kind = "video"

    def models(self):
        return [
            {"id": "gen4_turbo", "label": "Gen-4 Turbo", "kind": "video"},
            {"id": "gen3a_turbo", "label": "Gen-3 Alpha Turbo", "kind": "video"},
        ]

    def generate(self, job, model, key, on_progress):
        headers = {"Authorization": f"Bearer {key}", "X-Runway-Version": "2024-11-06"}
        ratio = _runway_ratio(int(job.get("width", 1280)), int(job.get("height", 720)), model)
        init_image = str(job.get("initImage") or "")
        prompt_text = _prompt_of(job)[:1000]
        if init_image:
            endpoint = "https://api.dev.runwayml.com/v1/image_to_video"
            body = {"model": model, "promptImage": _as_data_url(init_image),
                    "promptText": prompt_text, "ratio": ratio, "duration": 5}
        else:
            endpoint = "https://api.dev.runwayml.com/v1/text_to_video"
            body = {"model": model, "promptText": prompt_text, "ratio": ratio, "duration": 5}
        task = _http_json(self.id, endpoint, method="POST", headers=headers, body=body)
        task_id = task.get("id")
        if not task_id:
            raise CloudError(self.id, f"no task id in response: {json.dumps(task)[:200]}")
        started = _monotonic()
        while True:
            info = _http_json(self.id, f"https://api.dev.runwayml.com/v1/tasks/{task_id}",
                              headers=headers)
            status = str(info.get("status", ""))
            if status == "SUCCEEDED":
                output = info.get("output") or []
                if not output:
                    raise CloudError(self.id, "task succeeded but returned no output")
                # Output URLs are pre-signed; no auth header on the download.
                return _video_result(self.id, output[0], {}, job)
            if status in ("FAILED", "CANCELLED"):
                raise CloudError(self.id, f"task {status.lower()}: {info.get('failure') or info.get('failureCode') or ''}")
            on_progress({"phase": "queued" if status in ("PENDING", "THROTTLED") else "running",
                         "progress": _poll_progress(started, VIDEO_DEADLINE_S)})
            if _monotonic() - started > VIDEO_DEADLINE_S:
                raise CloudError(self.id, f"timed out after {VIDEO_DEADLINE_S}s waiting for the task")
            _sleep(POLL_INTERVAL_S)


PROVIDERS = {p.id: p for p in (
    OpenAIProvider(), StabilityProvider(), FalProvider(), ReplicateProvider(), RunwayProvider(),
)}


def provider_listing(keys):
    """Public listing for GET /cloud/providers. NEVER includes key values."""
    keys = keys if isinstance(keys, dict) else {}
    return [
        {"id": p.id, "label": p.label, "kind": p.kind, "models": p.models(),
         "hasKey": bool(str(keys.get(p.id, "") or "").strip())}
        for p in PROVIDERS.values()
    ]
```

- [ ] **Step 4: Run tests to verify pass** — `cd bridge && python test_cloud.py`. Expected: `bridge cloud: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add bridge/cloud.py bridge/test_cloud.py
git commit -m "feat(bridge): stdlib cloud provider layer (OpenAI, Stability, Fal, Replicate, Runway)"
```

---

### Task 2: `/cloud/*` routes + settings persistence in `bridge/server.py`

**Files:**
- Modify: `bridge/server.py` (docstring route list; `API_PREFIXES` line 46; guarded import near the `civitai` import ~line 37; settings helpers after `_prune_progress_files`; three routes inside `build_response` — insert directly before the `POST /generate` handler ~line 554)
- Test: `bridge/test_server.py` (append tests + `__main__` entries)

**Interfaces:**
- Consumes: `cloud.PROVIDERS`, `cloud.provider_listing`, `cloud.CloudError` (Task 1).
- Produces: `GET /cloud/providers` → `{"providers": [{id,label,kind,models,hasKey}]}`; `POST /cloud/keys` `{provider,key}` → `{"ok":true,"hasKey":bool}` (blank key clears); `POST /cloud/generate` `{provider,model,jobId,...RenderJob}` → worker result contract | 400 (unknown provider / missing model / missing key) | 502 (`{"error": "<provider>: ..."}`); env override `LUMENDECK_SETTINGS_PATH` for tests.

- [ ] **Step 1: Write the failing tests** — append to `bridge/test_server.py`:

```python
def _with_temp_settings(fn):
    """Run fn with LUMENDECK_SETTINGS_PATH pointed at a fresh temp file."""
    import tempfile
    old = os.environ.get("LUMENDECK_SETTINGS_PATH")
    fd, path = tempfile.mkstemp(prefix="lumendeck-settings-", suffix=".json")
    os.close(fd)
    os.remove(path)  # start from "missing file"
    os.environ["LUMENDECK_SETTINGS_PATH"] = path
    try:
        fn()
    finally:
        if old is None:
            os.environ.pop("LUMENDECK_SETTINGS_PATH", None)
        else:
            os.environ["LUMENDECK_SETTINGS_PATH"] = old
        if os.path.exists(path):
            os.remove(path)


def test_cloud_providers_route_lists_all_without_keys():
    def check():
        status, _headers, body = build_response("GET", "/cloud/providers", b"")
        assert status == 200
        providers = json.loads(body)["providers"]
        ids = {p["id"] for p in providers}
        assert ids == {"openai", "stability", "fal", "replicate", "runway"}
        assert all(p["hasKey"] is False for p in providers)
        assert all(p["models"] for p in providers)
        assert all("key" not in p for p in providers)  # never leak values
    _with_temp_settings(check)


def test_cloud_keys_persist_and_blank_clears():
    def check():
        payload = json.dumps({"provider": "openai", "key": "sk-test-123"}).encode()
        status, _h, body = build_response("POST", "/cloud/keys", payload)
        assert status == 200 and json.loads(body)["hasKey"] is True
        _s, _h, body = build_response("GET", "/cloud/providers", b"")
        by_id = {p["id"]: p for p in json.loads(body)["providers"]}
        assert by_id["openai"]["hasKey"] is True
        # blank key deletes the entry
        payload = json.dumps({"provider": "openai", "key": "  "}).encode()
        status, _h, body = build_response("POST", "/cloud/keys", payload)
        assert status == 200 and json.loads(body)["hasKey"] is False
        _s, _h, body = build_response("GET", "/cloud/providers", b"")
        by_id = {p["id"]: p for p in json.loads(body)["providers"]}
        assert by_id["openai"]["hasKey"] is False
    _with_temp_settings(check)


def test_cloud_keys_rejects_unknown_provider():
    def check():
        payload = json.dumps({"provider": "nope", "key": "x"}).encode()
        status, _h, body = build_response("POST", "/cloud/keys", payload)
        assert status == 400 and "unknown provider" in json.loads(body)["error"]
    _with_temp_settings(check)


def test_cloud_generate_requires_key():
    def check():
        payload = json.dumps({"provider": "openai", "model": "gpt-image-1", "prompt": "x"}).encode()
        status, _h, body = build_response("POST", "/cloud/generate", payload)
        assert status == 400 and "key" in json.loads(body)["error"].lower()
    _with_temp_settings(check)


def test_cloud_generate_success_and_progress_done():
    def check():
        build_response("POST", "/cloud/keys", json.dumps({"provider": "openai", "key": "sk-1"}).encode())
        import cloud as cloud_mod

        class FakeProvider:
            id = "openai"
            label = "OpenAI Images"

            def generate(self, job, model, key, on_progress):
                assert model == "gpt-image-1" and key == "sk-1"
                on_progress({"phase": "running", "progress": 0.5})
                return {"image_base64": "QUJD", "seed": "7", "mediaType": "image",
                        "mimeType": "image/png", "extension": "png"}

        original = cloud_mod.PROVIDERS["openai"]
        cloud_mod.PROVIDERS["openai"] = FakeProvider()
        try:
            payload = json.dumps({"provider": "openai", "model": "gpt-image-1",
                                  "prompt": "x", "jobId": "cloudtest1"}).encode()
            status, _h, body = build_response("POST", "/cloud/generate", payload)
            assert status == 200
            data = json.loads(body)
            assert data["image_base64"] == "QUJD"
            _s, _h, progress = build_response("GET", "/progress/cloudtest1", b"")
            assert json.loads(progress)["phase"] == "done"
        finally:
            cloud_mod.PROVIDERS["openai"] = original
    _with_temp_settings(check)


def test_cloud_generate_surfaces_cloud_error_as_502():
    def check():
        build_response("POST", "/cloud/keys", json.dumps({"provider": "openai", "key": "sk-1"}).encode())
        import cloud as cloud_mod

        class FailingProvider:
            id = "openai"
            label = "OpenAI Images"

            def generate(self, job, model, key, on_progress):
                raise cloud_mod.CloudError("openai", "HTTP 401: invalid key")

        original = cloud_mod.PROVIDERS["openai"]
        cloud_mod.PROVIDERS["openai"] = FailingProvider()
        try:
            payload = json.dumps({"provider": "openai", "model": "gpt-image-1", "prompt": "x"}).encode()
            status, _h, body = build_response("POST", "/cloud/generate", payload)
            assert status == 502
            assert "openai" in json.loads(body)["error"]
            assert "401" in json.loads(body)["error"]
        finally:
            cloud_mod.PROVIDERS["openai"] = original
    _with_temp_settings(check)
```

Add all six to the `__main__` block (before the final `print`):

```python
    test_cloud_providers_route_lists_all_without_keys()
    test_cloud_keys_persist_and_blank_clears()
    test_cloud_keys_rejects_unknown_provider()
    test_cloud_generate_requires_key()
    test_cloud_generate_success_and_progress_done()
    test_cloud_generate_surfaces_cloud_error_as_502()
```

- [ ] **Step 2: Run to verify failure** — `cd bridge && python test_server.py`. Expected: assertion failure on the first cloud test (404 for /cloud/providers → build_response falls through to static/404 handling).

- [ ] **Step 3: Implement in `bridge/server.py`**:

(a) `API_PREFIXES` (line 46): add `"/cloud"` to the tuple.

(b) Guarded import, right after the `civitai` try/except (~line 41):

```python
try:
    import cloud as cloud_providers
    _HAS_CLOUD = True
except Exception:
    _HAS_CLOUD = False
```

(c) Settings helpers, after `_prune_progress_files` (~line 107):

```python
# ---- Bridge-side settings (cloud API keys live here, NEVER in the browser) ----
def _settings_path() -> str:
    override = os.environ.get("LUMENDECK_SETTINGS_PATH")
    if override:
        return override
    root = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "LumenDeck")
    return os.path.join(root, "settings.json")


def _load_settings() -> dict:
    try:
        with open(_settings_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_settings(settings: dict) -> None:
    path = _settings_path()
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, indent=2)
```

(d) Routes inside `build_response`, inserted immediately BEFORE the `POST /generate` handler:

```python
    if method == "GET" and path == "/cloud/providers":
        headers["Content-Type"] = "application/json"
        if not _HAS_CLOUD:
            return 503, headers, json.dumps({"error": "cloud module unavailable in this build"}).encode()
        keys = _load_settings().get("cloudKeys") or {}
        return 200, headers, json.dumps({"providers": cloud_providers.provider_listing(keys)}).encode()

    if method == "POST" and path == "/cloud/keys":
        headers["Content-Type"] = "application/json"
        if not _HAS_CLOUD:
            return 503, headers, json.dumps({"error": "cloud module unavailable in this build"}).encode()
        try:
            req = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        provider_id = str(req.get("provider", ""))
        if provider_id not in cloud_providers.PROVIDERS:
            return 400, headers, json.dumps({"error": f"unknown provider: {provider_id or '(missing)'}"}).encode()
        key = str(req.get("key", "")).strip()
        settings = _load_settings()
        cloud_keys = settings.get("cloudKeys")
        if not isinstance(cloud_keys, dict):
            cloud_keys = {}
        if key:
            cloud_keys[provider_id] = key
        else:
            cloud_keys.pop(provider_id, None)  # blank key clears the entry
        settings["cloudKeys"] = cloud_keys
        try:
            _save_settings(settings)
        except OSError as exc:
            return 503, headers, json.dumps({"error": f"could not persist settings: {exc}"}).encode()
        return 200, headers, json.dumps({"ok": True, "hasKey": bool(key)}).encode()

    if method == "POST" and path == "/cloud/generate":
        headers["Content-Type"] = "application/json"
        if not _HAS_CLOUD:
            return 503, headers, json.dumps({"error": "cloud module unavailable in this build"}).encode()
        try:
            job = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        provider_id = str(job.get("provider", ""))
        provider = cloud_providers.PROVIDERS.get(provider_id)
        if provider is None:
            return 400, headers, json.dumps({"error": f"unknown provider: {provider_id or '(missing)'}"}).encode()
        model = str(job.get("model", ""))
        if not model:
            return 400, headers, json.dumps({"error": "model is required"}).encode()
        key = str((_load_settings().get("cloudKeys") or {}).get(provider_id, "")).strip()
        if not key:
            return 400, headers, json.dumps({
                "error": f"no API key saved for {provider.label}. Save one under Backend -> Cloud.",
            }).encode()
        job_id = str(job.get("jobId", ""))
        track = bool(_JOB_ID.match(job_id))
        if track:
            _prune_progress_files()
            _write_progress(job_id, {"phase": "loading"})

        def _report(update: dict) -> None:
            # Map cloud phases onto the progress shape the adapter already polls
            # ({phase, step, steps}); queued -> loading, running -> rendering.
            if not track:
                return
            phase = str(update.get("phase", "running"))
            try:
                fraction = max(0.0, min(1.0, float(update.get("progress") or 0.0)))
            except (TypeError, ValueError):
                fraction = 0.0
            if phase == "queued":
                _write_progress(job_id, {"phase": "loading"})
            else:
                _write_progress(job_id, {"phase": "rendering", "step": int(fraction * 100), "steps": 100})

        try:
            result = provider.generate(job, model, key, _report)
            if track:
                _write_progress(job_id, {"phase": "done"})
            return 200, headers, json.dumps(result).encode()
        except cloud_providers.CloudError as exc:
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 502, headers, json.dumps({"error": str(exc)}).encode()
        except Exception as exc:
            if track:
                _write_progress(job_id, {"phase": "error"})
            return 502, headers, json.dumps({"error": f"{provider_id}: {exc}"}).encode()
```

(e) Docstring (top of file): add the three routes to the route list:

```
  GET  /cloud/providers -> hosted providers + curated models + hasKey
  POST /cloud/keys -> persist a provider API key bridge-side (blank key clears)
  POST /cloud/generate -> run one RenderJob on a hosted provider (loud errors)
```

- [ ] **Step 4: Run tests to verify pass** — `cd bridge && python test_server.py` → `bridge server: all checks passed`; also re-run `python test_cloud.py`.

- [ ] **Step 5: Commit**

```bash
git add bridge/server.py bridge/test_server.py
git commit -m "feat(bridge): /cloud/providers, /cloud/keys, /cloud/generate routes with bridge-side key storage"
```

---

### Task 3: `src/bridge/cloudAdapter.ts` + tests (+ export `resolveBase`, fix unbound-fetch default)

**Files:**
- Create: `src/bridge/cloudAdapter.ts`
- Create: `src/bridge/cloudAdapter.test.ts`
- Modify: `src/bridge/httpAdapter.ts:29` (`function resolveBase` → `export function resolveBase`) and `:93` (constructor default `fetchImpl` — see below)

**Interfaces:**
- Consumes: `BackendAdapter`, `RenderJob`, `RenderResult`, `RenderProgressCallback`, `EvolveStepResult`, `SvdModelInfo` from `./adapter`; `DEFAULT_BRIDGE_URL`, `resolveBase` from `./httpAdapter`.
- Produces: `CloudAdapter` class (`id:'cloud'`, `setBaseUrl(url)`, `setProvider(id)`, `setModel(id)`, `listProviders(): Promise<CloudProviderInfo[]>`, `saveKey(provider,key): Promise<boolean>` plus full `BackendAdapter`); types `CloudProviderInfo { id; label; kind; models: CloudModelInfo[]; hasKey }`, `CloudModelInfo { id; label; kind: 'image'|'video' }`. Task 4 imports these.

- [ ] **Step 1: Fix the latent unbound-fetch bug in `httpAdapter.ts`** (we touch this file anyway for `resolveBase`; storing the global `fetch` as a property and calling `this.fetchImpl(...)` re-binds `this` to the adapter → "Illegal invocation" TypeError in browsers):

```ts
// line 29
export function resolveBase(url: string): string {

// line 93 constructor — replace `fetchImpl: typeof fetch = fetch` with:
  constructor(base: string = DEFAULT_BRIDGE_URL, fetchImpl?: typeof fetch) {
    // NOTE: never default to the bare global `fetch` — assigning it to a property
    // and invoking as this.fetchImpl(...) rebinds `this` and throws
    // "Illegal invocation" in browsers. Wrap it so `this` stays undefined.
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.setBaseUrl(base);
  }
```

- [ ] **Step 2: Write the failing tests** — `src/bridge/cloudAdapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CloudAdapter } from './cloudAdapter';
import { buildRenderJob } from './adapter';
import { createDefaultWorkflow } from '../core/workflow';

interface RecordedCall { url: string; method: string; body: unknown }

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; json?: unknown }) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = handler(url, init);
    return new Response(JSON.stringify(out.json ?? {}), {
      status: out.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function job() {
  return buildRenderJob(createDefaultWorkflow());
}

describe('CloudAdapter', () => {
  it('POSTs provider/model/jobId to /cloud/generate and maps an image result', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.includes('/cloud/generate')) {
        return { json: { image_base64: 'QUJD', seed: '42', mediaType: 'image', mimeType: 'image/png', extension: 'png' } };
      }
      return { json: { phase: 'unknown' } };
    });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    adapter.setProvider('openai');
    adapter.setModel('gpt-image-1');
    const result = await adapter.generate(job());
    const post = calls.find((c) => c.url.includes('/cloud/generate'));
    expect(post?.method).toBe('POST');
    const body = post?.body as Record<string, unknown>;
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-image-1');
    expect(typeof body.jobId).toBe('string');
    expect(result.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(result.mediaType).toBe('image');
    expect(result.seed).toBe(42);
  });

  it('maps a video result to video/mp4', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/cloud/generate')
        ? { json: { video_base64: 'TVBG', mediaType: 'video', mimeType: 'video/mp4', extension: 'mp4', seed: '7' } }
        : { json: { phase: 'unknown' } });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    adapter.setProvider('runway');
    adapter.setModel('gen4_turbo');
    const result = await adapter.generate(job());
    expect(result.dataUrl).toBe('data:video/mp4;base64,TVBG');
    expect(result.mediaType).toBe('video');
    expect(result.extension).toBe('mp4');
  });

  it('throws the bridge error message on a 502 CloudError', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/cloud/generate')
        ? { status: 502, json: { error: 'openai: HTTP 401: invalid key' } }
        : { json: { phase: 'unknown' } });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    await expect(adapter.generate(job())).rejects.toThrow(/openai: HTTP 401/);
  });

  it('throws when the response has no media payload', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/cloud/generate') ? { json: { seed: '1' } } : { json: { phase: 'unknown' } });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    await expect(adapter.generate(job())).rejects.toThrow(/media data/);
  });

  it('listProviders returns the providers array and saveKey posts provider+key', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.includes('/cloud/providers')) {
        return { json: { providers: [{ id: 'openai', label: 'OpenAI Images', kind: 'image', models: [], hasKey: false }] } };
      }
      if (url.includes('/cloud/keys')) return { json: { ok: true, hasKey: true } };
      return { json: {} };
    });
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    const providers = await adapter.listProviders();
    expect(providers[0].id).toBe('openai');
    const saved = await adapter.saveKey('openai', 'sk-x');
    expect(saved).toBe(true);
    const post = calls.find((c) => c.url.includes('/cloud/keys'));
    expect(post?.body).toEqual({ provider: 'openai', key: 'sk-x' });
  });

  it('is loudly unsupported for SVD/evolve/motion and lists no SVD models', async () => {
    const { impl } = stubFetch(() => ({ json: {} }));
    const adapter = new CloudAdapter('http://127.0.0.1:8787', impl);
    await expect(adapter.animateStill()).rejects.toThrow(/Cloud backend/);
    await expect(adapter.evolveStep()).rejects.toThrow(/Cloud backend/);
    await expect(adapter.renderMotion()).rejects.toThrow(/Cloud backend/);
    await expect(adapter.listSvdModels()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/bridge/cloudAdapter.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 4: Write `src/bridge/cloudAdapter.ts`**:

```ts
import type {
  BackendAdapter,
  EvolveStepResult,
  RenderJob,
  RenderProgressCallback,
  RenderResult,
  SvdModelInfo,
} from './adapter';
import { DEFAULT_BRIDGE_URL, resolveBase } from './httpAdapter';

/** One curated model offered by a cloud provider. */
export interface CloudModelInfo {
  id: string;
  label: string;
  kind: 'image' | 'video';
}

/** One hosted provider as reported by GET /cloud/providers. */
export interface CloudProviderInfo {
  id: string;
  label: string;
  kind: 'image' | 'video' | 'both';
  models: CloudModelInfo[];
  /** true when the bridge has an API key saved for this provider (value never leaves the bridge). */
  hasKey: boolean;
}

const NOT_ON_CLOUD =
  'is not available on the Cloud backend — switch Backend to the local Diffusers bridge. The Cloud backend renders single images/videos only.';

/**
 * Hosted-API backend. All provider HTTP happens on the local bridge
 * (/cloud/generate) so API keys never touch the browser; this adapter only
 * talks to the bridge and mirrors HttpAdapter's progress polling + result
 * mapping. SVD/evolve/motion are LOUDLY unsupported (never a fake).
 */
export class CloudAdapter implements BackendAdapter {
  id = 'cloud';
  label = 'Cloud (hosted APIs)';
  private base = DEFAULT_BRIDGE_URL;
  private provider = 'openai';
  private model = '';
  private fetchImpl: typeof fetch;

  constructor(base: string = DEFAULT_BRIDGE_URL, fetchImpl?: typeof fetch) {
    // Wrap the global fetch so `this` stays undefined (see httpAdapter note).
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.setBaseUrl(base);
  }

  setBaseUrl(url: string): void {
    this.base = resolveBase(url);
  }

  setProvider(provider: string): void {
    this.provider = provider;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/cloud/providers`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listProviders(): Promise<CloudProviderInfo[]> {
    const res = await this.fetchImpl(`${this.base}/cloud/providers`);
    const data = (await res.json().catch(() => null)) as { providers?: CloudProviderInfo[]; error?: string } | null;
    if (!res.ok || !data?.providers) {
      throw new Error(data?.error ?? `Bridge /cloud/providers failed: ${res.status}`);
    }
    return data.providers;
  }

  /** Persist (or clear, with an empty string) a provider key on the bridge. */
  async saveKey(provider: string, key: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.base}/cloud/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; hasKey?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error ?? `Bridge /cloud/keys failed: ${res.status}`);
    return Boolean(data.hasKey);
  }

  async generate(job: RenderJob, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    onProgress?.({ progress: 0.05, phase: 'queued' });
    const jobId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;

    // Live progress: poll the bridge's per-job endpoint while the POST is in
    // flight (the bridge maps provider polls onto {phase, step, steps}).
    let polling = Boolean(onProgress);
    const pollLoop = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 600));
        if (!polling) break;
        try {
          const res = await this.fetchImpl(`${this.base}/progress/${jobId}`, { signal: AbortSignal.timeout(1200) });
          if (!res.ok) continue;
          const p = (await res.json()) as { phase?: string; step?: number; steps?: number };
          if (p.phase === 'loading') onProgress?.({ progress: 0.1, phase: 'queued' });
          else if (p.phase === 'rendering' && p.steps && p.steps > 0) {
            const progress = Math.min(0.95, 0.15 + 0.8 * ((p.step ?? 0) / p.steps));
            onProgress?.({ progress, phase: 'rendering' });
          }
        } catch {
          // ignore — progress is advisory
        }
      }
    };
    if (polling) void pollLoop();

    try {
      const res = await this.fetchImpl(`${this.base}/cloud/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...job, provider: this.provider, model: this.model, jobId }),
      });
      const data = (await res.json().catch(() => null)) as {
        image_base64?: string;
        video_base64?: string;
        mediaType?: 'image' | 'video';
        mimeType?: string;
        extension?: string;
        seed?: number | string;
        error?: string;
      } | null;
      if (!res.ok || !data || data.error) {
        throw new Error(data?.error ?? `Cloud render failed (${res.status}).`);
      }
      const mediaType = data.mediaType ?? (data.video_base64 ? 'video' : 'image');
      const mimeType = data.mimeType ?? (mediaType === 'video' ? 'video/mp4' : 'image/png');
      const payload = data.video_base64 ?? data.image_base64;
      if (!payload) throw new Error('Cloud render response did not include media data.');
      const dataUrl = `data:${mimeType};base64,${payload}`;
      onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
      return {
        dataUrl,
        mediaType,
        mimeType,
        extension: data.extension ?? (mediaType === 'video' ? 'mp4' : 'png'),
        seed: typeof data.seed === 'number' ? data.seed : Number(data.seed) || job.seed,
      };
    } finally {
      polling = false;
    }
  }

  async renderMotion(): Promise<RenderResult> {
    throw new Error(`Motion-clip rendering ${NOT_ON_CLOUD}`);
  }

  async animateStill(): Promise<RenderResult> {
    throw new Error(`SVD animation ${NOT_ON_CLOUD}`);
  }

  async evolveStep(): Promise<EvolveStepResult> {
    throw new Error(`Auto-Evolve ${NOT_ON_CLOUD}`);
  }

  async listSvdModels(): Promise<SvdModelInfo[]> {
    return [];
  }
}
```

- [ ] **Step 5: Run tests to verify pass** — `npx vitest run src/bridge/cloudAdapter.test.ts` → all pass. Also `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/bridge/cloudAdapter.ts src/bridge/cloudAdapter.test.ts src/bridge/httpAdapter.ts
git commit -m "feat(adapter): CloudAdapter (bridge-proxied hosted APIs), export resolveBase, fix unbound-fetch default"
```

---

### Task 4: settings + store + manifest + panel wiring

**Files:**
- Modify: `src/turboForge/backends/backendSettings.ts`
- Create: `src/turboForge/backends/backendSettings.test.ts`
- Modify: `src/state/store.ts` (imports ~line 3-5; `export const cloudAdapter` at line 592; `activeAdapter` ~line 710; `testSelectedBackend` ~line 1916; manifest.render at the MAIN render site ~line 2312)
- Modify: `src/core/manifest.ts:26` (render record type)
- Create: `src/components/CloudBackendSection.tsx`
- Modify: `src/components/BackendSettingsPanel.tsx` (option + section + copy line)
- Modify: `src/components/evolve/EvolvePanel.tsx:41` (cloud reason)
- Modify: `src/components/motion/MotionTimeline.tsx:202` (cloud gate + hint)
- Test: `src/state/store.test.ts` (append)

**Interfaces:**
- Consumes: `CloudAdapter`, `CloudProviderInfo` (Task 3).
- Produces: `RenderBackendId` includes `'cloud'`; `BackendSettings.cloudProvider/cloudModel: string`; store exports `cloudAdapter`; manifest render records `cloudProvider?/cloudModel?`.

- [ ] **Step 1: Write failing settings tests** — `src/turboForge/backends/backendSettings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKEND_SETTINGS,
  sanitizeBackendSettings,
  settingsBackendToTurboBackend,
} from './backendSettings';

describe('cloud backend settings', () => {
  it('defaults cloudProvider to openai and cloudModel to empty', () => {
    const s = sanitizeBackendSettings(undefined);
    expect(s.cloudProvider).toBe('openai');
    expect(s.cloudModel).toBe('');
    expect(DEFAULT_BACKEND_SETTINGS.cloudProvider).toBe('openai');
  });

  it('accepts cloud as a backend and maps it to future-cloud for turbo', () => {
    const s = sanitizeBackendSettings({ selectedBackend: 'cloud' });
    expect(s.selectedBackend).toBe('cloud');
    expect(settingsBackendToTurboBackend('cloud')).toBe('future-cloud');
  });

  it('preserves saved provider/model and trims whitespace', () => {
    const s = sanitizeBackendSettings({ cloudProvider: ' fal ', cloudModel: ' fal-ai/flux/dev ' });
    expect(s.cloudProvider).toBe('fal');
    expect(s.cloudModel).toBe('fal-ai/flux/dev');
  });
});
```

Run: `npx vitest run src/turboForge/backends/backendSettings.test.ts` — FAIL (unknown properties).

- [ ] **Step 2: Implement `backendSettings.ts` changes**:

```ts
export type RenderBackendId = 'mock' | 'bridge' | 'comfyui' | 'cloud';
```

`BackendSettings` gains (after `bridgeRenderer`):

```ts
  /** Hosted provider id for the Cloud backend (keys live on the bridge, not here). */
  cloudProvider: string;
  /** Curated model id within the chosen cloud provider. */
  cloudModel: string;
```

`DEFAULT_BACKEND_SETTINGS` gains `cloudProvider: 'openai', cloudModel: '',`.

`settingsBackendToTurboBackend` gains (before the final return):

```ts
  if (id === 'cloud') return 'future-cloud' as const;
```

`sanitizeBackendSettings` gains (inside the returned object):

```ts
    cloudProvider: (settings?.cloudProvider ?? '').trim() || DEFAULT_BACKEND_SETTINGS.cloudProvider,
    cloudModel: (settings?.cloudModel ?? '').trim(),
```

Run the settings tests → PASS.

- [ ] **Step 3: Store wiring** — `src/state/store.ts`:

(a) Import + singleton (next to the other adapters, line ~5 and ~592):

```ts
import { CloudAdapter } from '../bridge/cloudAdapter';
// ...
export const cloudAdapter = new CloudAdapter();
```

(b) `activeAdapter` (~line 710) — insert before the `return mockAdapter;`:

```ts
  if (settings.selectedBackend === 'cloud') {
    // Cloud calls are proxied through the LOCAL bridge so keys stay off the browser.
    cloudAdapter.setBaseUrl(settings.bridgeUrl);
    cloudAdapter.setProvider(settings.cloudProvider);
    cloudAdapter.setModel(settings.cloudModel);
    return cloudAdapter;
  }
```

(c) `testSelectedBackend` (~line 1916) — insert a branch before the final `else` (bridge):

```ts
      } else if (state.backendSettings.selectedBackend === 'cloud') {
        cloudAdapter.setBaseUrl(state.backendSettings.bridgeUrl);
        const reachable = await cloudAdapter.ping();
        if (!reachable) {
          ok = false;
          status = 'unavailable';
          message = 'Local bridge is offline — the Cloud backend calls providers through it.';
        } else {
          const providers = await cloudAdapter.listProviders().catch(() => []);
          const chosen = providers.find((p) => p.id === state.backendSettings.cloudProvider);
          ok = Boolean(chosen?.hasKey);
          status = chosen?.hasKey ? 'healthy' : 'degraded';
          message = !chosen
            ? 'Pick a cloud provider and save its API key.'
            : chosen.hasKey
              ? `${chosen.label} is configured and ready.`
              : `No API key saved for ${chosen.label}. Add one in the Cloud section below.`;
        }
      }
```

(d) Manifest provenance at the MAIN render site (~line 2312, the `manifest.render = {` inside the queue-render path that uses `renderMode`) — append inside the object literal:

```ts
          ...(backendSettings.selectedBackend === 'cloud'
            ? { cloudProvider: backendSettings.cloudProvider, cloudModel: backendSettings.cloudModel }
            : {}),
```

(e) `src/core/manifest.ts:26` — the `render?:` record gains:

```ts
    /** hosted provider + model for a Cloud-backend render (absent otherwise). */
    cloudProvider?: string;
    cloudModel?: string;
```

- [ ] **Step 4: Store test** — append to `src/state/store.test.ts`:

```ts
describe('cloud backend selection', () => {
  it('setAdapter(cloud) selects the cloud backend and future-cloud turbo id', () => {
    useStudio.getState().setAdapter('cloud');
    expect(useStudio.getState().adapterId).toBe('cloud');
    expect(useStudio.getState().backendSettings.selectedBackend).toBe('cloud');
    expect(useStudio.getState().turboBackendId).toBe('future-cloud');
    useStudio.getState().setAdapter('mock'); // restore for other tests
  });
});
```

Run: `npx vitest run src/state/store.test.ts` → PASS.

- [ ] **Step 5: Panel** — create `src/components/CloudBackendSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { CloudProviderInfo } from '../bridge/cloudAdapter';
import { cloudAdapter, useStudio } from '../state/store';
import { Icon } from './icons';

/**
 * Cloud backend configuration: provider + curated model pickers and a
 * per-provider API-key field. The key is POSTed straight to the LOCAL bridge
 * (settings.json) and never enters the store or localStorage.
 */
export function CloudBackendSection() {
  const backendSettings = useStudio((s) => s.backendSettings);
  const updateBackendSettings = useStudio((s) => s.updateBackendSettings);
  const [providers, setProviders] = useState<CloudProviderInfo[] | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    cloudAdapter.setBaseUrl(backendSettings.bridgeUrl);
    return cloudAdapter.listProviders();
  };

  useEffect(() => {
    let cancelled = false;
    load()
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        setError(null);
      })
      .catch((exc: unknown) => {
        if (cancelled) return;
        setProviders([]);
        setError(
          `Bridge unreachable (${exc instanceof Error ? exc.message : String(exc)}). ` +
            'The Cloud backend calls providers through the local bridge — start LumenDeck’s bridge first.',
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendSettings.bridgeUrl]);

  const chosen = providers?.find((p) => p.id === backendSettings.cloudProvider) ?? null;
  const models = chosen?.models ?? [];
  const modelValue = models.some((m) => m.id === backendSettings.cloudModel) ? backendSettings.cloudModel : '';

  const saveKey = async (value: string) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hasKey = await cloudAdapter.saveKey(chosen.id, value);
      setKeyDraft('');
      setNotice(hasKey ? 'Key saved on the local bridge.' : 'Key cleared.');
      setProviders(await load());
    } catch (exc: unknown) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cloud-backend-section">
      <label className="field">
        <span className="field-label">Cloud provider</span>
        <select
          value={backendSettings.cloudProvider}
          onChange={(event) => {
            const id = event.target.value;
            const next = providers?.find((p) => p.id === id);
            updateBackendSettings({ cloudProvider: id, cloudModel: next?.models[0]?.id ?? '' });
          }}
        >
          {(providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.hasKey ? ' — key saved' : ''}
            </option>
          ))}
          {providers === null ? <option value={backendSettings.cloudProvider}>loading…</option> : null}
        </select>
        <span className="field-help">All calls go through the local bridge; your key never enters the browser.</span>
      </label>

      <label className="field">
        <span className="field-label">Model</span>
        <select value={modelValue} onChange={(event) => updateBackendSettings({ cloudModel: event.target.value })}>
          <option value="" disabled>
            pick a model…
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.kind})
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">{chosen ? `${chosen.label} API key` : 'API key'}</span>
        <input
          type="password"
          value={keyDraft}
          placeholder={chosen?.hasKey ? 'key saved — paste to replace' : 'paste your API key'}
          autoComplete="off"
          onChange={(event) => setKeyDraft(event.target.value)}
        />
        <span className="field-help">Stored in the bridge&apos;s settings.json on this machine only.</span>
      </label>
      <div className="turbo-actions">
        <button className="btn primary" type="button" disabled={busy || !chosen || !keyDraft.trim()} onClick={() => void saveKey(keyDraft.trim())}>
          {Icon.download()} {busy ? 'Saving…' : 'Save key'}
        </button>
        <button className="btn" type="button" disabled={busy || !chosen?.hasKey} onClick={() => void saveKey('')}>
          Clear key
        </button>
      </div>

      {chosen && !chosen.hasKey ? (
        <div className="backend-health status-degraded" role="status">
          <strong>no key</strong>
          <span>No API key saved for {chosen.label} — cloud renders will fail until you add one.</span>
        </div>
      ) : null}
      {notice ? <p className="field-help">{notice}</p> : null}
      {error ? <p className="backend-model-error">{error}</p> : null}
    </div>
  );
}
```

Note: if the repo has no eslint (only tsc), drop the `eslint-disable` comment line.

- [ ] **Step 6: Wire the panel** — `src/components/BackendSettingsPanel.tsx`:
  - Import: `import { CloudBackendSection } from './CloudBackendSection';`
  - Copy line 32-34 becomes: `Mock works offline. ComfyUI requires a local ComfyUI server with API access. Cloud calls hosted APIs through the local bridge.`
  - Backend `<select>` gains `<option value="cloud">Cloud (hosted APIs)</option>` after the bridge option.
  - After the bridge block (`{backendSettings.selectedBackend === 'bridge' ? (...) : null}`), add:

```tsx
      {backendSettings.selectedBackend === 'cloud' ? <CloudBackendSection /> : null}
```

- [ ] **Step 7: Honest gates** —
  - `src/components/evolve/EvolvePanel.tsx` `runDisabledReason` (line ~41) gains, before the `!bridgeOnline` line:

```ts
    if (adapterId === 'cloud') return 'Auto-Evolve runs on the local Diffusers bridge — the Cloud backend renders single images/videos only.';
```

  - `src/components/motion/MotionTimeline.tsx` (line ~202): add `const isCloudBackend = adapterId === 'cloud';` next to `isMockBackend`; find the render-clip button (the one whose `onClick` calls `doRenderClip`) and add `|| isCloudBackend` to its `disabled` expression; directly under that button add:

```tsx
      {isCloudBackend ? (
        <p className="field-help">
          Motion clips render frame-by-frame on the local bridge — switch Backend to the Diffusers bridge.
          The Cloud backend generates single stills/videos only.
        </p>
      ) : null}
```

  - Gallery SVD Animate needs NO change: it already gates on `svdBackend !== 'bridge'` (Gallery.tsx:235), which covers `cloud`. Verify only.

- [ ] **Step 8: Verify** — `npm run typecheck` clean, `npx vitest run` all green.

- [ ] **Step 9: Commit**

```bash
git add src/turboForge/backends/backendSettings.ts src/turboForge/backends/backendSettings.test.ts src/state/store.ts src/state/store.test.ts src/core/manifest.ts src/components/CloudBackendSection.tsx src/components/BackendSettingsPanel.tsx src/components/evolve/EvolvePanel.tsx src/components/motion/MotionTimeline.tsx
git commit -m "feat(app): Cloud backend — settings, store resolver, panel UI, manifest provenance, honest gates"
```

---

### Task 5: bump 0.33.0, full verify, PR

**Files:**
- Modify: `package.json:4`, `src-tauri/tauri.conf.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/Cargo.lock` (the `name = "lumendeck"` package block)

- [ ] **Step 1: Bump all four version files to `0.33.0`** (Cargo.lock: edit the `version` line inside the `[[package]] name = "lumendeck"` block only).

- [ ] **Step 2: Full verification suite:**

```bash
npm run typecheck        # clean
npx vitest run           # all files pass (existing ~856 + new cloud tests)
cd bridge && python test_cloud.py && python test_server.py && cd ..
npm run build            # tsc + vite build succeed
```

- [ ] **Step 3: Commit + push + PR**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to 0.33.0 (cloud provider backends)"
git push -u origin feature/cloud-providers
gh pr create --title "Cloud provider backends: OpenAI, Stability, Fal, Replicate, Runway (v0.33.0)" --body "<summary + HONEST LIMIT statement: live provider calls require real paid API keys, absent in dev; adapters are unit-tested against mocked HTTP; live verification is the user's step with their own key. Local pipeline stays the default backend.>"
```

- [ ] **Step 4: Adversarial review (Workflow) + fix confirmed findings, re-verify, then hand back for merge decision.** Do NOT merge or release without explicit user direction.
