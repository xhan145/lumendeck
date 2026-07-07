"""Auto-evolve (Living Constellation Phase 4) tests for the Python bridge.

Pure: torch/CLIP and the persistent worker are mocked, so nothing loads a real
model or downloads CLIP weights. Covers scorer.score_images blend math + the
CLIP-absent degradation (clipAvailable False, renormalized onto aesthetics) +
score/breakdown ranges [0,1]; diffusers_backend.evolve_step validation / clamp /
controlnetMap injection / loud errors; and the /evolve-step route through
build_response (shape, population clamp, progress, and the LOUD 503 paths -- evolve
has no procedural fallback).

Run with pytest, or standalone: `python test_evolve.py`.
"""
import json

import diffusers_backend as db
import scorer
import server
from server import build_response


# ---------------------------------------------------------------------------
# scorer._blend: weighted blend math + honest CLIP-absent degradation
# ---------------------------------------------------------------------------

def _close(actual, expected, tol=1e-9):
    return abs(float(actual) - float(expected)) <= tol


def test_blend_equal_weights_averages():
    assert _close(scorer._blend(0.8, 0.4, {"clip": 0.5, "aesthetic": 0.5}, True), 0.6)


def test_blend_clip_only_weight():
    assert _close(scorer._blend(0.8, 0.4, {"clip": 1.0, "aesthetic": 0.0}, True), 0.8)


def test_blend_aesthetic_only_weight():
    assert _close(scorer._blend(0.8, 0.4, {"clip": 0.0, "aesthetic": 1.0}, True), 0.4)


def test_blend_renormalizes_uneven_weights():
    # clip 0.9 @ 0.75, aesthetic 0.1 @ 0.25 -> (0.9*3 + 0.1*1)/4 = 0.7.
    assert _close(scorer._blend(0.9, 0.1, {"clip": 0.75, "aesthetic": 0.25}, True), 0.7)


def test_blend_clip_unavailable_uses_aesthetic_only():
    # Even with a clip-heavy weighting, an unavailable CLIP degrades to aesthetics.
    assert _close(scorer._blend(None, 0.42, {"clip": 1.0, "aesthetic": 0.0}, False), 0.42)


def test_blend_zero_weights_defaults_to_equal_blend():
    assert _close(scorer._blend(0.8, 0.4, {"clip": 0.0, "aesthetic": 0.0}, True), 0.6)


def test_blend_clamps_into_unit_interval():
    assert scorer._blend(5.0, 5.0, {"clip": 1.0, "aesthetic": 1.0}, True) == 1.0
    assert scorer._blend(-5.0, -5.0, {"clip": 1.0, "aesthetic": 1.0}, True) == 0.0


# ---------------------------------------------------------------------------
# scorer._aesthetic_metrics: deterministic, every metric in [0,1]
# ---------------------------------------------------------------------------

def _flat_image(size=(32, 32), value=(120, 120, 120)):
    from PIL import Image
    return Image.new("RGB", size, value)


def _noisy_image(size=(32, 32), seed=0):
    import numpy as np
    from PIL import Image
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, size=(size[1], size[0], 3), dtype="uint8")
    return Image.fromarray(arr, "RGB")


def test_aesthetic_metrics_all_in_unit_interval():
    for image in (_flat_image(), _noisy_image()):
        metrics = scorer._aesthetic_metrics(image)
        for key in ("sharpness", "contrast", "colorfulness", "entropy", "aesthetic"):
            assert 0.0 <= metrics[key] <= 1.0, (key, metrics[key])


def test_aesthetic_metrics_noise_scores_higher_than_flat():
    flat = scorer._aesthetic_metrics(_flat_image())
    noisy = scorer._aesthetic_metrics(_noisy_image())
    # A flat gray field has ~zero sharpness/entropy; random noise has plenty.
    assert noisy["sharpness"] > flat["sharpness"]
    assert noisy["entropy"] > flat["entropy"]
    assert noisy["aesthetic"] > flat["aesthetic"]


# ---------------------------------------------------------------------------
# scorer.score_images: CLIP mocked present, and the honest absent path
# ---------------------------------------------------------------------------

def test_score_images_with_clip_present_blends_and_ranges():
    old = scorer._clip_scores
    try:
        # Mock CLIP: deterministic per-image similarities, never a real download.
        scorer._clip_scores = lambda images, prompt: ([0.9, 0.1], None)
        images = [_noisy_image(seed=1), _flat_image()]
        results, clip_available, reason = scorer.score_images(
            images, "a prompt", {"clip": 1.0, "aesthetic": 0.0},
        )
        assert clip_available is True and reason is None
        # clip-only weighting -> score equals the (mocked) clip value exactly.
        assert _close(results[0]["score"], 0.9) and _close(results[1]["score"], 0.1)
        for result in results:
            assert 0.0 <= result["score"] <= 1.0
            assert 0.0 <= result["clip"] <= 1.0
            assert 0.0 <= result["aesthetic"] <= 1.0
    finally:
        scorer._clip_scores = old


def test_score_images_clip_absent_degrades_loudly():
    old = scorer._clip_scores
    try:
        # CLIP unavailable: no fabricated number, a reason is surfaced.
        scorer._clip_scores = lambda images, prompt: (None, "CLIP off for test")
        images = [_noisy_image(seed=2), _noisy_image(seed=3)]
        # A clip-heavy weighting must still fall back to aesthetics only.
        results, clip_available, reason = scorer.score_images(
            images, "a prompt", {"clip": 0.9, "aesthetic": 0.1},
        )
        assert clip_available is False
        assert reason == "CLIP off for test"
        for result in results:
            assert result["clip"] is None  # never a fake clip score
            assert 0.0 <= result["aesthetic"] <= 1.0
            # Renormalized onto aesthetics: score is exactly the aesthetic value.
            assert _close(result["score"], result["aesthetic"])
    finally:
        scorer._clip_scores = old


# ---------------------------------------------------------------------------
# diffusers_backend.evolve_step: validation, clamp, controlnetMap, loud errors
# ---------------------------------------------------------------------------

class _RecordingWorker:
    """Stand-in persistent worker that records the payload it was handed."""

    def __init__(self, result=None):
        self.result = result if result is not None else {
            "candidates": [
                {"image_base64": "AAA", "score": 0.5, "breakdown": {"clip": 0.5, "aesthetic": 0.5}, "index": 0},
            ],
            "clipAvailable": True,
        }
        self.calls = []

    def request(self, command, payload, timeout=1800):
        self.calls.append((command, payload, timeout))
        return self.result


def _with_ready_worker(worker):
    old_status = db.model_status
    old_worker = db._persistent_worker
    db.model_status = lambda: {"dependenciesReady": True}
    db._persistent_worker = worker
    return old_status, old_worker


def _restore(old_status, old_worker):
    db.model_status = old_status
    db._persistent_worker = old_worker


def test_evolve_step_injects_controlnet_map_and_forwards_params():
    worker = _RecordingWorker()
    saved = _with_ready_worker(worker)
    try:
        out = db.evolve_step({
            "jobs": [{"prompt": "a", "cfg": 4}, {"prompt": "a", "cfg": 9}],
            "prompt": "a cat",
            "weights": {"clip": 0.7, "aesthetic": 0.3},
            "progressPath": "/tmp/evolve.json",
        })
        assert out["clipAvailable"] is True
        assert len(worker.calls) == 1
        command, payload, _timeout = worker.calls[0]
        assert command == "evolve_step"
        assert payload["prompt"] == "a cat"
        assert payload["weights"] == {"clip": 0.7, "aesthetic": 0.3}
        assert payload["progressPath"] == "/tmp/evolve.json"
        # ControlNet map injected into EVERY job (worker resolves repos from it).
        for job in payload["jobs"]:
            assert job["controlnetMap"] is db.CONTROLNET_MODELS
    finally:
        _restore(*saved)


def test_evolve_step_raises_when_runtime_missing():
    old_status = db.model_status
    try:
        db.model_status = lambda: {"dependenciesReady": False}
        try:
            db.evolve_step({"jobs": [{"prompt": "x"}]})
            assert False, "expected RuntimeError when runtime not installed"
        except RuntimeError as exc:
            assert "runtime" in str(exc).lower()
    finally:
        db.model_status = old_status


def test_evolve_step_rejects_empty_jobs():
    worker = _RecordingWorker()
    saved = _with_ready_worker(worker)
    try:
        for bad in ({"jobs": []}, {"jobs": None}, {"jobs": "nope"}, {}):
            try:
                db.evolve_step(bad)
                assert False, f"expected RuntimeError for payload {bad!r}"
            except RuntimeError as exc:
                assert "jobs" in str(exc).lower()
        assert worker.calls == []  # never reached the worker
    finally:
        _restore(*saved)


def test_evolve_step_rejects_non_object_job():
    worker = _RecordingWorker()
    saved = _with_ready_worker(worker)
    try:
        try:
            db.evolve_step({"jobs": [{"prompt": "ok"}, "not-a-dict"]})
            assert False, "expected RuntimeError for a non-object job"
        except RuntimeError as exc:
            assert "job 1" in str(exc)
    finally:
        _restore(*saved)


def test_evolve_step_surfaces_worker_error_loudly():
    worker = _RecordingWorker(result={"error": "cuda oom"})
    saved = _with_ready_worker(worker)
    try:
        try:
            db.evolve_step({"jobs": [{"prompt": "x"}]})
            assert False, "expected the worker error to surface"
        except RuntimeError as exc:
            assert "cuda oom" in str(exc)
    finally:
        _restore(*saved)


def test_evolve_step_falls_back_to_oneshot_when_worker_exits():
    old_status = db.model_status
    old_persistent = db._persistent_worker
    old_worker = db._worker

    class BrokenWorker:
        def request(self, command, payload, timeout=1800):
            raise RuntimeError("diffusers worker exited unexpectedly (see worker.log)")

    captured = {}

    def fake_oneshot(command, payload, timeout=1800):
        captured["command"] = command
        return {"candidates": [], "clipAvailable": False}

    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = BrokenWorker()
        db._worker = fake_oneshot
        out = db.evolve_step({"jobs": [{"prompt": "x"}]})
        assert captured["command"] == "evolve_step"
        assert out["clipAvailable"] is False
    finally:
        db.model_status = old_status
        db._persistent_worker = old_persistent
        db._worker = old_worker


# ---------------------------------------------------------------------------
# /evolve-step route through build_response
# ---------------------------------------------------------------------------

def _evolve_body(job_count=3, **over):
    body = {
        "jobs": [
            {"prompt": "orb", "seed": 5, "cfg": 4 + i, "width": 96, "height": 96, "steps": 4}
            for i in range(job_count)
        ],
        "prompt": "a glowing orb",
        "weights": {"clip": 0.6, "aesthetic": 0.4},
    }
    body.update(over)
    return json.dumps(body).encode()


def test_evolve_step_route_rejects_invalid_json():
    status, _headers, body = build_response("POST", "/evolve-step", b"{not json")
    assert status == 400
    assert "invalid JSON" in json.loads(body)["error"]


def test_evolve_step_route_rejects_missing_jobs():
    status, _headers, body = build_response("POST", "/evolve-step", json.dumps({"prompt": "x"}).encode())
    assert status == 400
    assert "non-empty" in json.loads(body)["error"]


def test_evolve_step_route_rejects_non_object_jobs():
    payload = json.dumps({"jobs": [{"prompt": "ok"}, "nope"], "prompt": "x"}).encode()
    status, _headers, body = build_response("POST", "/evolve-step", payload)
    assert status == 400
    assert "object" in json.loads(body)["error"]


def test_evolve_step_route_loud_503_when_diffusers_unavailable():
    old_avail = server._diffusers_available
    try:
        server._diffusers_available = lambda: False
        status, _headers, body = build_response("POST", "/evolve-step", _evolve_body())
        assert status == 503  # loud, never a procedural fallback for scoring
        assert "runtime" in json.loads(body)["error"].lower()
    finally:
        server._diffusers_available = old_avail


def test_evolve_step_route_success_calls_backend():
    old_avail = server._diffusers_available
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    captured = {}

    class FakeBackend:
        @staticmethod
        def evolve_step(payload):
            captured["payload"] = payload
            return {
                "candidates": [
                    {"image_base64": "QUJD", "score": 0.7, "breakdown": {"clip": 0.8, "aesthetic": 0.6}, "index": i}
                    for i in range(len(payload["jobs"]))
                ],
                "clipAvailable": True,
            }

    try:
        server._diffusers_available = lambda: True
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeBackend
        status, _headers, body = build_response("POST", "/evolve-step", _evolve_body(jobId="evo-1"))
        assert status == 200
        out = json.loads(body)
        assert out["clipAvailable"] is True
        assert len(out["candidates"]) == 3
        first = out["candidates"][0]
        assert set(first) == {"image_base64", "score", "breakdown", "index"}
        assert set(first["breakdown"]) == {"clip", "aesthetic"}
        # prompt + weights forwarded to the backend.
        assert captured["payload"]["prompt"] == "a glowing orb"
        assert captured["payload"]["weights"] == {"clip": 0.6, "aesthetic": 0.4}
        # Each job was annotated with a modelRef (via _resolve_render_targets).
        for job in captured["payload"]["jobs"]:
            assert "modelRef" in job
        # jobId tracked -> a progress path was threaded to the worker.
        assert captured["payload"]["progressPath"].endswith("evo-1.json")
        # progress file ends at 'done'.
        p_status, _h, p_body = build_response("GET", "/progress/evo-1", b"")
        assert p_status == 200 and json.loads(p_body)["phase"] == "done"
    finally:
        server._diffusers_available = old_avail
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_evolve_step_route_clamps_population_to_8():
    old_avail = server._diffusers_available
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    captured = {}

    class FakeBackend:
        @staticmethod
        def evolve_step(payload):
            captured["payload"] = payload
            return {"candidates": [], "clipAvailable": True}

    try:
        server._diffusers_available = lambda: True
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeBackend
        status, _headers, _body = build_response("POST", "/evolve-step", _evolve_body(job_count=12))
        assert status == 200
        assert len(captured["payload"]["jobs"]) == 8  # clamped server-side (2..8)
    finally:
        server._diffusers_available = old_avail
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_evolve_step_route_passes_through_clip_unavailable():
    old_avail = server._diffusers_available
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    class FakeBackend:
        @staticmethod
        def evolve_step(_payload):
            return {
                "candidates": [
                    {"image_base64": "QUJD", "score": 0.5, "breakdown": {"clip": None, "aesthetic": 0.5}, "index": 0},
                ],
                "clipAvailable": False,
                "fallbackReason": "CLIP is unavailable; scoring on aesthetic heuristics only.",
            }

    try:
        server._diffusers_available = lambda: True
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeBackend
        status, _headers, body = build_response("POST", "/evolve-step", _evolve_body())
        assert status == 200
        out = json.loads(body)
        assert out["clipAvailable"] is False
        assert "CLIP is unavailable" in out["fallbackReason"]  # loudly labeled
        assert out["candidates"][0]["breakdown"]["clip"] is None  # never a fake number
    finally:
        server._diffusers_available = old_avail
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_evolve_step_route_loud_503_when_backend_raises():
    old_avail = server._diffusers_available
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    class FakeBackend:
        @staticmethod
        def evolve_step(_payload):
            raise RuntimeError("worker blew up")

    try:
        server._diffusers_available = lambda: True
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeBackend
        status, _headers, body = build_response("POST", "/evolve-step", _evolve_body(jobId="evo-err"))
        assert status == 503  # evolve requires real renders: loud, no fallback
        assert "worker blew up" in json.loads(body)["error"]
        # progress file marks the error, never a silent 'done'.
        _p, _h, p_body = build_response("GET", "/progress/evo-err", b"")
        assert json.loads(p_body)["phase"] == "error"
    finally:
        server._diffusers_available = old_avail
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_evolve_step_is_registered_as_api_prefix():
    # SPA fallback must never swallow the API route.
    assert "/evolve-step" in server.API_PREFIXES


if __name__ == "__main__":
    test_blend_equal_weights_averages()
    test_blend_clip_only_weight()
    test_blend_aesthetic_only_weight()
    test_blend_renormalizes_uneven_weights()
    test_blend_clip_unavailable_uses_aesthetic_only()
    test_blend_zero_weights_defaults_to_equal_blend()
    test_blend_clamps_into_unit_interval()
    test_aesthetic_metrics_all_in_unit_interval()
    test_aesthetic_metrics_noise_scores_higher_than_flat()
    test_score_images_with_clip_present_blends_and_ranges()
    test_score_images_clip_absent_degrades_loudly()
    test_evolve_step_injects_controlnet_map_and_forwards_params()
    test_evolve_step_raises_when_runtime_missing()
    test_evolve_step_rejects_empty_jobs()
    test_evolve_step_rejects_non_object_job()
    test_evolve_step_surfaces_worker_error_loudly()
    test_evolve_step_falls_back_to_oneshot_when_worker_exits()
    test_evolve_step_route_rejects_invalid_json()
    test_evolve_step_route_rejects_missing_jobs()
    test_evolve_step_route_rejects_non_object_jobs()
    test_evolve_step_route_loud_503_when_diffusers_unavailable()
    test_evolve_step_route_success_calls_backend()
    test_evolve_step_route_clamps_population_to_8()
    test_evolve_step_route_passes_through_clip_unavailable()
    test_evolve_step_route_loud_503_when_backend_raises()
    test_evolve_step_is_registered_as_api_prefix()
    print("evolve: all checks passed")
