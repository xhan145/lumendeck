"""Motion render (Living Constellation Phase 2) tests for the Python bridge.

Pure: the worker and the mp4 encoder (cv2) are mocked, so nothing loads torch or
writes a real video. Covers diffusers_backend.render_motion validation/clamp/
controlnetMap injection, the _encode_sequence format selection (mp4 then gif),
and the /render-motion route through build_response (success + loud fallback).

Run with pytest, or standalone: `python test_motion_render.py`.
"""
import base64
import json
import sys
import types

import diffusers_backend as db
import server
from server import build_response


# ---------------------------------------------------------------------------
# render_motion: validation, clamp, controlnetMap injection
# ---------------------------------------------------------------------------

class _RecordingWorker:
    """Stand-in persistent worker that records the payload it was handed."""

    def __init__(self, result=None):
        self.result = result or {
            "video_base64": "AAA",
            "mediaType": "video",
            "mimeType": "video/mp4",
            "extension": "mp4",
            "seed": 7,
            "frameCount": 2,
            "fps": 8,
        }
        self.calls = []

    def request(self, command, payload, timeout=1800):
        self.calls.append((command, payload, timeout))
        return self.result


def _with_ready_worker(worker):
    """Context helper: make render_motion see a ready runtime + the given worker."""
    old_status = db.model_status
    old_worker = db._persistent_worker
    db.model_status = lambda: {"dependenciesReady": True}
    db._persistent_worker = worker
    return old_status, old_worker


def _restore(old_status, old_worker):
    db.model_status = old_status
    db._persistent_worker = old_worker


def test_render_motion_rejects_empty_jobs():
    worker = _RecordingWorker()
    saved = _with_ready_worker(worker)
    try:
        for bad in ({"jobs": []}, {"jobs": None}, {"jobs": "nope"}, {}):
            try:
                db.render_motion(bad)
                assert False, f"expected RuntimeError for payload {bad!r}"
            except RuntimeError as exc:
                assert "jobs" in str(exc).lower()
        assert worker.calls == []  # never reached the worker
    finally:
        _restore(*saved)


def test_render_motion_rejects_non_object_job():
    worker = _RecordingWorker()
    saved = _with_ready_worker(worker)
    try:
        try:
            db.render_motion({"jobs": [{"prompt": "ok"}, "not-a-dict"]})
            assert False, "expected RuntimeError for a non-object job"
        except RuntimeError as exc:
            assert "job 1" in str(exc)
    finally:
        _restore(*saved)


def test_render_motion_raises_when_runtime_missing():
    old_status = db.model_status
    try:
        db.model_status = lambda: {"dependenciesReady": False}
        try:
            db.render_motion({"jobs": [{"prompt": "x"}]})
            assert False, "expected RuntimeError when runtime not installed"
        except RuntimeError as exc:
            assert "runtime" in str(exc).lower()
    finally:
        db.model_status = old_status


def test_render_motion_injects_controlnet_map_and_forwards_params():
    worker = _RecordingWorker()
    saved = _with_ready_worker(worker)
    try:
        out = db.render_motion({
            "jobs": [{"prompt": "a", "cfg": 4}, {"prompt": "b", "cfg": 18}],
            "fps": 12,
            "format": "gif",
            "progressPath": "/tmp/clip.json",
        })
        assert out["mediaType"] == "video"
        assert len(worker.calls) == 1
        command, payload, _timeout = worker.calls[0]
        assert command == "render_sequence"
        assert payload["fps"] == 12 and payload["format"] == "gif"
        assert payload["progressPath"] == "/tmp/clip.json"
        # ControlNet map injected into EVERY job (worker resolves repos from it).
        for job in payload["jobs"]:
            assert job["controlnetMap"] is db.CONTROLNET_MODELS
    finally:
        _restore(*saved)


def test_render_motion_surfaces_worker_error_loudly():
    worker = _RecordingWorker(result={"error": "cuda oom"})
    saved = _with_ready_worker(worker)
    try:
        try:
            db.render_motion({"jobs": [{"prompt": "x"}]})
            assert False, "expected the worker error to surface"
        except RuntimeError as exc:
            assert "cuda oom" in str(exc)
    finally:
        _restore(*saved)


def test_render_motion_falls_back_to_oneshot_when_worker_exits():
    old_status = db.model_status
    old_persistent = db._persistent_worker
    old_worker = db._worker

    class BrokenWorker:
        def request(self, command, payload, timeout=1800):
            raise RuntimeError("diffusers worker exited unexpectedly (see worker.log)")

    captured = {}

    def fake_oneshot(command, payload, timeout=1800):
        captured["command"] = command
        return {"video_base64": "ZZ", "mediaType": "video", "mimeType": "video/mp4",
                "extension": "mp4", "seed": 1, "frameCount": 1, "fps": 8}

    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = BrokenWorker()
        db._worker = fake_oneshot
        out = db.render_motion({"jobs": [{"prompt": "x"}]})
        assert captured["command"] == "render_sequence"
        assert out["video_base64"] == "ZZ"
    finally:
        db.model_status = old_status
        db._persistent_worker = old_persistent
        db._worker = old_worker


# ---------------------------------------------------------------------------
# _encode_sequence: mp4 when cv2 works, gif fallback when cv2 raises
# ---------------------------------------------------------------------------

def _solid_frames(n=3, size=(8, 8)):
    from PIL import Image
    return [Image.new("RGB", size, (i * 40 % 256, 0, 0)) for i in range(n)]


def _install_fake_cv2(monkey_ok=True):
    """Install a fake cv2 module. monkey_ok=True -> a working writer; else raises."""
    fake = types.ModuleType("cv2")

    def fourcc(*_chars):
        return 0x7634706D  # 'mp4v'

    fake.VideoWriter_fourcc = fourcc

    class _Writer:
        def __init__(self, path, _fourcc, _fps, _size):
            self._path = path
            self._frames = 0
            if not monkey_ok:
                raise RuntimeError("cv2 backend unavailable")

        def isOpened(self):
            return True

        def write(self, _frame):
            self._frames += 1

        def release(self):
            # Write a small non-empty file so the reader gets real bytes.
            with open(self._path, "wb") as fh:
                fh.write(b"\x00\x00\x00\x18ftypmp42FAKE-MP4")

    fake.VideoWriter = _Writer
    return fake


def test_encode_sequence_uses_mp4_when_cv2_ok():
    fake_cv2 = _install_fake_cv2(monkey_ok=True)
    old_cv2 = sys.modules.get("cv2")
    sys.modules["cv2"] = fake_cv2
    try:
        out = db._encode_sequence(_solid_frames(3), fps=8, fmt="mp4")
        assert out["mimeType"] == "video/mp4" and out["extension"] == "mp4"
        assert base64.b64decode(out["video_base64"]).startswith(b"\x00\x00\x00\x18ftyp")
    finally:
        if old_cv2 is None:
            sys.modules.pop("cv2", None)
        else:
            sys.modules["cv2"] = old_cv2


def test_encode_sequence_falls_back_to_gif_when_cv2_raises():
    fake_cv2 = _install_fake_cv2(monkey_ok=False)
    old_cv2 = sys.modules.get("cv2")
    sys.modules["cv2"] = fake_cv2
    try:
        out = db._encode_sequence(_solid_frames(3), fps=8, fmt="mp4")
        assert out["mimeType"] == "image/gif" and out["extension"] == "gif"
        assert base64.b64decode(out["video_base64"]).startswith(b"GIF89a")
    finally:
        if old_cv2 is None:
            sys.modules.pop("cv2", None)
        else:
            sys.modules["cv2"] = old_cv2


def test_encode_sequence_gif_format_never_touches_cv2():
    # A poisoned cv2 must not even be imported when gif is explicitly requested.
    poison = types.ModuleType("cv2")

    def _boom(*_a, **_k):
        raise AssertionError("cv2 must not be used for an explicit gif request")

    poison.VideoWriter_fourcc = _boom
    poison.VideoWriter = _boom
    old_cv2 = sys.modules.get("cv2")
    sys.modules["cv2"] = poison
    try:
        out = db._encode_sequence(_solid_frames(2), fps=6, fmt="gif")
        assert out["extension"] == "gif"
        assert base64.b64decode(out["video_base64"]).startswith(b"GIF89a")
    finally:
        if old_cv2 is None:
            sys.modules.pop("cv2", None)
        else:
            sys.modules["cv2"] = old_cv2


def test_encode_sequence_single_frame_still_encodes():
    out = db._encode_sequence(_solid_frames(1), fps=8, fmt="gif")
    assert out["extension"] == "gif"
    assert base64.b64decode(out["video_base64"]).startswith(b"GIF89a")


def test_encode_sequence_rejects_zero_frames():
    try:
        db._encode_sequence([], fps=8, fmt="gif")
        assert False, "expected RuntimeError for zero frames"
    except RuntimeError as exc:
        assert "zero frames" in str(exc)


# ---------------------------------------------------------------------------
# /render-motion route through build_response
# ---------------------------------------------------------------------------

def _motion_body(**over):
    body = {
        "jobs": [
            {"prompt": "orb", "seed": 5, "cfg": 4, "width": 96, "height": 96, "steps": 4},
            {"prompt": "orb", "seed": 5, "cfg": 18, "width": 96, "height": 96, "steps": 4},
            {"prompt": "orb", "seed": 5, "cfg": 7, "width": 96, "height": 96, "steps": 4},
        ],
        "fps": 8,
        "format": "gif",
    }
    body.update(over)
    return json.dumps(body).encode()


def test_render_motion_route_rejects_missing_jobs():
    status, _headers, body = build_response("POST", "/render-motion", json.dumps({"fps": 8}).encode())
    assert status == 400
    assert "non-empty" in json.loads(body)["error"]


def test_render_motion_route_rejects_invalid_json():
    status, _headers, body = build_response("POST", "/render-motion", b"{not json")
    assert status == 400
    assert "invalid JSON" in json.loads(body)["error"]


def test_render_motion_route_rejects_non_object_jobs():
    payload = json.dumps({"jobs": [{"prompt": "ok"}, "nope"], "fps": 8}).encode()
    status, _headers, body = build_response("POST", "/render-motion", payload)
    assert status == 400
    assert "object" in json.loads(body)["error"]


def test_render_motion_route_fallback_when_diffusers_unavailable():
    old_avail = server._diffusers_available
    try:
        server._diffusers_available = lambda: False
        status, headers, body = build_response("POST", "/render-motion", _motion_body())
        assert status == 200
        out = json.loads(body)
        assert out["mediaType"] == "video"
        assert out["mimeType"] == "image/gif" and out["extension"] == "gif"
        assert out["fallback"] is True
        assert out["fallbackReason"]  # loud, never silent
        assert out["frameCount"] == 3
        assert base64.b64decode(out["video_base64"]).startswith(b"GIF89a")
    finally:
        server._diffusers_available = old_avail


def test_render_motion_route_success_calls_backend():
    old_avail = server._diffusers_available
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    captured = {}

    class FakeBackend:
        @staticmethod
        def render_motion(payload):
            captured["payload"] = payload
            return {
                "video_base64": "QUJD",
                "mediaType": "video",
                "mimeType": "video/mp4",
                "extension": "mp4",
                "seed": 5,
                "frameCount": len(payload["jobs"]),
                "fps": payload["fps"],
            }

    try:
        server._diffusers_available = lambda: True
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeBackend
        status, _headers, body = build_response("POST", "/render-motion", _motion_body(format="mp4", jobId="clip-1"))
        assert status == 200
        out = json.loads(body)
        assert out["extension"] == "mp4" and out["mimeType"] == "video/mp4"
        assert out.get("fallback") is None  # real render: not a fallback
        assert out["frameCount"] == 3 and out["fps"] == 8
        # Each job was annotated with a modelRef (via _resolve_render_targets).
        for job in captured["payload"]["jobs"]:
            assert "modelRef" in job
        assert captured["payload"]["format"] == "mp4"
        # jobId tracked -> a progress path was threaded to the worker.
        assert captured["payload"]["progressPath"].endswith("clip-1.json")
        # progress file ends at 'done'.
        p_status, _h, p_body = build_response("GET", "/progress/clip-1", b"")
        assert p_status == 200 and json.loads(p_body)["phase"] == "done"
    finally:
        server._diffusers_available = old_avail
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_render_motion_route_falls_back_loudly_when_backend_raises():
    old_avail = server._diffusers_available
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    class FakeBackend:
        @staticmethod
        def render_motion(_payload):
            raise RuntimeError("worker blew up")

    try:
        server._diffusers_available = lambda: True
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeBackend
        status, _headers, body = build_response("POST", "/render-motion", _motion_body())
        assert status == 200
        out = json.loads(body)
        assert out["fallback"] is True
        assert "worker blew up" in out["fallbackReason"]
        assert out["extension"] == "gif"  # procedural fallback is always a gif
    finally:
        server._diffusers_available = old_avail
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_render_motion_route_clamps_to_120_frames():
    old_avail = server._diffusers_available
    try:
        server._diffusers_available = lambda: False
        jobs = [{"prompt": "x", "seed": 1, "cfg": 7, "width": 64, "height": 64} for _ in range(150)]
        status, _headers, body = build_response("POST", "/render-motion", json.dumps({"jobs": jobs, "fps": 8, "format": "gif"}).encode())
        assert status == 200
        out = json.loads(body)
        assert out["frameCount"] == 120  # clamped server-side
    finally:
        server._diffusers_available = old_avail


def test_render_motion_is_registered_as_api_prefix():
    # SPA fallback must never swallow the API route.
    assert "/render-motion" in server.API_PREFIXES


if __name__ == "__main__":
    test_render_motion_rejects_empty_jobs()
    test_render_motion_rejects_non_object_job()
    test_render_motion_raises_when_runtime_missing()
    test_render_motion_injects_controlnet_map_and_forwards_params()
    test_render_motion_surfaces_worker_error_loudly()
    test_render_motion_falls_back_to_oneshot_when_worker_exits()
    test_encode_sequence_uses_mp4_when_cv2_ok()
    test_encode_sequence_falls_back_to_gif_when_cv2_raises()
    test_encode_sequence_gif_format_never_touches_cv2()
    test_encode_sequence_single_frame_still_encodes()
    test_encode_sequence_rejects_zero_frames()
    test_render_motion_route_rejects_missing_jobs()
    test_render_motion_route_rejects_invalid_json()
    test_render_motion_route_rejects_non_object_jobs()
    test_render_motion_route_fallback_when_diffusers_unavailable()
    test_render_motion_route_success_calls_backend()
    test_render_motion_route_falls_back_loudly_when_backend_raises()
    test_render_motion_route_clamps_to_120_frames()
    test_render_motion_is_registered_as_api_prefix()
    print("motion render: all checks passed")
