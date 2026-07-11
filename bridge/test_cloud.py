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
