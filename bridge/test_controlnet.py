"""ControlNet system tests — capability map, family estimation, worker
normalization/preprocess helpers, and the /controlnet routes. Pure: no GPU, no
torch, no network.

Run with pytest, or standalone: `python test_controlnet.py`.
"""
import base64
import io
import json
import os
import shutil
import struct
import tempfile

import diffusers_backend as db
import server
from server import build_response

try:
    from PIL import Image
    _HAS_PIL = True
except Exception:
    _HAS_PIL = False

FULL_SET = ["canny", "depth", "pose", "scribble", "lineart", "softedge", "tile"]


# ---- capability map -----------------------------------------------------------


def test_controlnet_map_matches_contract():
    assert set(db.CONTROLNET_MODELS) == {"SD1.5", "SD2.1", "SDXL"}
    assert list(db.CONTROLNET_MODELS["SD1.5"]) == FULL_SET
    assert list(db.CONTROLNET_MODELS["SD2.1"]) == ["canny", "depth", "pose"]
    assert list(db.CONTROLNET_MODELS["SDXL"]) == ["canny", "depth", "pose", "scribble", "tile"]
    for family, table in db.CONTROLNET_MODELS.items():
        for ctype, repo in table.items():
            assert isinstance(repo, str) and repo.count("/") == 1, (family, ctype, repo)


# ---- estimate_family ----------------------------------------------------------


def test_estimate_family_hub_heuristics():
    assert db.estimate_family({"kind": "hub", "id": "stabilityai/sdxl-turbo"}) == "SDXL"
    assert db.estimate_family({"kind": "hub", "id": "stabilityai/sd-turbo"}) == "SD2.1"
    assert db.estimate_family({"kind": "hub", "id": "stabilityai/stable-diffusion-2-1"}) == "SD2.1"
    assert db.estimate_family({"kind": "hub", "id": "runwayml/stable-diffusion-v1-5"}) == "SD1.5"
    # No id -> exactly what the default model would estimate to.
    assert db.estimate_family({"kind": "hub"}) == db.estimate_family({"kind": "hub", "id": db.model_id()})
    assert db.estimate_family(None) == db.estimate_family({"kind": "hub"})


def _write_safetensors(path, tensors):
    """Minimal valid .safetensors: 8-byte LE header length + JSON header + zeros."""
    header = {}
    offset = 0
    for key, shape in tensors.items():
        numel = 1
        for dim in shape:
            numel *= dim
        header[key] = {"dtype": "F16", "shape": list(shape), "data_offsets": [offset, offset + numel * 2]}
        offset += numel * 2
    blob = json.dumps(header).encode()
    with open(path, "wb") as fh:
        fh.write(struct.pack("<Q", len(blob)))
        fh.write(blob)
        fh.write(b"\x00" * offset)


def test_estimate_family_reads_safetensors_headers():
    root = tempfile.mkdtemp()
    try:
        xl = os.path.join(root, "innocuous_name.safetensors")
        _write_safetensors(xl, {"add_embedding.linear_1.weight": (1280, 2816)})
        assert db.estimate_family({"kind": "file", "path": xl}) == "SDXL"

        sd21 = os.path.join(root, "two_one.safetensors")
        _write_safetensors(sd21, {"cond_stage_model.model.ln_final.weight": (1024,)})
        assert db.estimate_family({"kind": "file", "path": sd21}) == "SD2.1"

        sd21_dim = os.path.join(root, "two_one_hf.safetensors")
        _write_safetensors(sd21_dim, {
            "model.diffusion_model.input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight": (320, 1024),
        })
        assert db.estimate_family({"kind": "file", "path": sd21_dim}) == "SD2.1"

        sd15 = os.path.join(root, "one_five.safetensors")
        _write_safetensors(sd15, {
            "cond_stage_model.transformer.text_model.final_layer_norm.weight": (768,),
            "model.diffusion_model.input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight": (320, 768),
        })
        assert db.estimate_family({"kind": "file", "path": sd15}) == "SD1.5"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_estimate_family_unreadable_file_falls_back_to_hints():
    root = tempfile.mkdtemp()
    try:
        bad_xl = os.path.join(root, "broken_xl.safetensors")
        open(bad_xl, "wb").write(b"junk")
        assert db.estimate_family({"kind": "file", "path": bad_xl}) == "SDXL"

        bad = os.path.join(root, "broken.safetensors")
        open(bad, "wb").write(b"junk")
        assert db.estimate_family({"kind": "file", "path": bad}) == "SD1.5"
        assert db.estimate_family({"kind": "file", "path": bad, "family": "SDXL"}) == "SDXL"

        missing = os.path.join(root, "nope.safetensors")
        assert db.estimate_family({"kind": "file", "path": missing, "family": "SDXL"}) == "SDXL"
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ---- worker helpers (exec'd from the template; module level is stdlib-only) ----


def _worker_ns():
    ns = {"__name__": "diffusers_worker_under_test"}
    exec(compile(db._WORKER_SOURCE, "diffusers_worker.py", "exec"), ns)
    return ns


def test_worker_normalize_controls_list_legacy_both_none():
    normalize = _worker_ns()["normalize_controls"]
    a = {"model": "depth", "strength": 0.8, "image": "AAAA"}
    b = {"model": "pose", "strength": 1.0, "image": "BBBB"}
    legacy = {"model": "canny", "strength": 0.5, "image": "CCCC"}
    assert normalize({"controlNets": [a, b]}) == [a, b]
    assert normalize({"controlNet": legacy}) == [legacy]
    # Both present: the list wins (controlNet only mirrors the first entry).
    assert normalize({"controlNets": [a, b], "controlNet": a}) == [a, b]
    assert normalize({}) == []
    assert normalize({"controlNets": []}) == []
    assert normalize({"controlNet": None}) == []
    # Image-less or malformed slots don't count.
    assert normalize({"controlNets": [{"model": "depth", "strength": 1.0}]}) == []
    assert normalize({"controlNets": [{"model": "depth", "image": ""}, "junk"]}) == []


def test_worker_preprocess_tile_and_canny_need_no_controlnet_aux():
    if not _HAS_PIL:
        return  # PIL missing in this test env; worker runtimes always have it
    ns = _worker_ns()
    img = Image.new("RGB", (32, 24), (200, 30, 30))
    tile = ns["preprocess_control"]("tile", img, 64, 48)
    assert tile.size == (64, 48) and tile.mode == "RGB"
    canny = ns["preprocess_control"]("canny", img, 64, 48)
    assert canny.size == (64, 48) and canny.mode == "RGB"


def test_worker_preprocess_rejects_unknown_type():
    if not _HAS_PIL:
        return
    ns = _worker_ns()
    img = Image.new("RGB", (8, 8))
    try:
        ns["preprocess_control"]("wheel", img, 8, 8)
        assert False, "expected an unknown-type error"
    except RuntimeError as exc:
        assert "unknown control type" in str(exc)


def test_worker_depth_without_controlnet_aux_names_the_package():
    if not _HAS_PIL:
        return
    try:
        import controlnet_aux  # noqa: F401
        return  # installed in this env; the clear-error path can't trigger here
    except Exception:
        pass
    ns = _worker_ns()
    img = Image.new("RGB", (8, 8))
    try:
        ns["preprocess_control"]("depth", img, 8, 8)
        assert False, "expected a controlnet_aux error"
    except RuntimeError as exc:
        assert "controlnet_aux" in str(exc)


def test_worker_do_preprocess_returns_png_map_base64():
    if not _HAS_PIL:
        return
    ns = _worker_ns()
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (10, 200, 30)).save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    out = ns["do_preprocess"]({"type": "tile", "image": "data:image/png;base64," + b64, "width": 32, "height": 32})
    raw = base64.b64decode(out["map_base64"])
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    assert Image.open(io.BytesIO(raw)).size == (32, 32)


def test_worker_do_preprocess_requires_an_image():
    ns = _worker_ns()
    try:
        ns["do_preprocess"]({"type": "canny"})
        assert False, "expected a missing-image error"
    except RuntimeError as exc:
        assert "image" in str(exc)


# ---- module plumbing: generate()/preprocess() <-> worker -----------------------


class _FakeWorker:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def request(self, command, payload, timeout=1800):
        self.requests.append((command, payload))
        return self.response


def test_generate_injects_map_and_forwards_dropped_controls():
    old_status, old_worker = db.model_status, db._persistent_worker
    fake = _FakeWorker({"image_base64": "ok", "seed": 3,
                        "droppedControls": [{"type": "lineart", "reason": "unsupported"}]})
    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = fake
        out = db.generate({"prompt": "x", "seed": 3,
                           "controlNets": [{"model": "lineart", "strength": 1.0, "image": "AA"}]})
        command, payload = fake.requests[0]
        assert command == "generate"
        assert payload["controlnetMap"] == db.CONTROLNET_MODELS
        assert out["droppedControls"] == [{"type": "lineart", "reason": "unsupported"}]
    finally:
        db.model_status, db._persistent_worker = old_status, old_worker


def test_preprocess_calls_worker_with_map():
    old_status, old_worker = db.model_status, db._persistent_worker
    fake = _FakeWorker({"map_base64": "abc"})
    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = fake
        out = db.preprocess({"type": "canny", "image": "zzzz"})
        command, payload = fake.requests[0]
        assert command == "preprocess"
        assert payload["controlnetMap"] == db.CONTROLNET_MODELS
        assert out == {"map_base64": "abc"}
    finally:
        db.model_status, db._persistent_worker = old_status, old_worker


def test_preprocess_raises_on_worker_error():
    old_status, old_worker = db.model_status, db._persistent_worker
    try:
        db.model_status = lambda: {"dependenciesReady": True}
        db._persistent_worker = _FakeWorker({"error": "boom"})
        try:
            db.preprocess({"type": "canny", "image": "zzzz"})
            assert False, "expected RuntimeError from the worker error"
        except RuntimeError as exc:
            assert "boom" in str(exc)
    finally:
        db.model_status, db._persistent_worker = old_status, old_worker


# ---- capabilities() + routes ----------------------------------------------------


def test_capabilities_default_hub_and_file():
    caps = db.capabilities(None, [], None)
    expected_family = db.estimate_family({"kind": "hub"})
    assert caps == {"family": expected_family, "types": list(db.CONTROLNET_MODELS[expected_family])}

    caps_xl = db.capabilities("diffusers-sdxl", [], None)
    assert caps_xl == {"family": "SDXL", "types": ["canny", "depth", "pose", "scribble", "tile"]}

    root = tempfile.mkdtemp()
    try:
        path = os.path.join(root, "custom.safetensors")
        _write_safetensors(path, {"add_embedding.linear_1.weight": (1280, 2816)})
        shelf = [{"id": "scan-1", "assetType": "checkpoint", "path": "custom.safetensors", "family": ""}]
        assert db.capabilities("scan-1", shelf, root)["family"] == "SDXL"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_capabilities_route_shape():
    status, _headers, body = build_response("GET", "/controlnet/capabilities?model=diffusers-sdxl", b"")
    assert status == 200
    data = json.loads(body)
    assert data["family"] == "SDXL"
    assert data["types"] == ["canny", "depth", "pose", "scribble", "tile"]


def test_capabilities_route_without_diffusers_module_is_static():
    old = server._HAS_DIFFUSERS_MODULE
    try:
        server._HAS_DIFFUSERS_MODULE = False
        status, _headers, body = build_response("GET", "/controlnet/capabilities", b"")
        assert status == 200
        assert json.loads(body) == {"family": "SD1.5", "types": FULL_SET, "available": False}
    finally:
        server._HAS_DIFFUSERS_MODULE = old


def test_preprocess_route_rejects_bad_type_and_missing_image():
    payload = json.dumps({"type": "wheel", "image": "AAAA"}).encode()
    status, _headers, body = build_response("POST", "/controlnet/preprocess", payload)
    assert status == 400
    assert "unknown control type" in json.loads(body)["error"]

    payload = json.dumps({"type": "depth"}).encode()
    status, _headers, body = build_response("POST", "/controlnet/preprocess", payload)
    assert status == 400
    assert "image" in json.loads(body)["error"]


def test_preprocess_route_surfaces_backend_errors():
    old_has, old_backend = server._HAS_DIFFUSERS_MODULE, server.diffusers_backend

    class FakeDiffusers:
        @staticmethod
        def preprocess(job):
            raise RuntimeError("Diffusers runtime is not installed yet. Use Install runtime + model first.")

    try:
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeDiffusers
        payload = json.dumps({"type": "depth", "image": "AAAA"}).encode()
        status, _headers, body = build_response("POST", "/controlnet/preprocess", payload)
        assert status == 503
        assert "not installed" in json.loads(body)["error"]
    finally:
        server._HAS_DIFFUSERS_MODULE, server.diffusers_backend = old_has, old_backend


def test_preprocess_route_without_diffusers_module_503():
    old = server._HAS_DIFFUSERS_MODULE
    try:
        server._HAS_DIFFUSERS_MODULE = False
        payload = json.dumps({"type": "canny", "image": "AAAA"}).encode()
        status, _headers, body = build_response("POST", "/controlnet/preprocess", payload)
        assert status == 503
        assert "not available" in json.loads(body)["error"]
    finally:
        server._HAS_DIFFUSERS_MODULE = old


if __name__ == "__main__":
    test_controlnet_map_matches_contract()
    test_estimate_family_hub_heuristics()
    test_estimate_family_reads_safetensors_headers()
    test_estimate_family_unreadable_file_falls_back_to_hints()
    test_worker_normalize_controls_list_legacy_both_none()
    test_worker_preprocess_tile_and_canny_need_no_controlnet_aux()
    test_worker_preprocess_rejects_unknown_type()
    test_worker_depth_without_controlnet_aux_names_the_package()
    test_worker_do_preprocess_returns_png_map_base64()
    test_worker_do_preprocess_requires_an_image()
    test_generate_injects_map_and_forwards_dropped_controls()
    test_preprocess_calls_worker_with_map()
    test_preprocess_raises_on_worker_error()
    test_capabilities_default_hub_and_file()
    test_capabilities_route_shape()
    test_capabilities_route_without_diffusers_module_is_static()
    test_preprocess_route_rejects_bad_type_and_missing_image()
    test_preprocess_route_surfaces_backend_errors()
    test_preprocess_route_without_diffusers_module_503()
    print("bridge controlnet: all checks passed")
