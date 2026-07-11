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
