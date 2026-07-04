import json
import os

import server
from server import build_response


def test_health_reports_procedural_and_diffusers_flag():
    status, _headers, body = build_response("GET", "/health", b"")
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "ok" and data["adapter"] == "procedural"
    assert "diffusers" in data
    assert "model" in data


def test_models_returns_list():
    status, _headers, body = build_response("GET", "/models", b"")
    assert status == 200 and isinstance(json.loads(body), list)


def test_model_folder_status_route():
    status, _headers, body = build_response("GET", "/model-folder", b"")
    assert status == 200
    data = json.loads(body)
    assert "configured" in data
    assert "active" in data
    assert "assetCount" in data


def test_model_folder_rejects_missing_folder():
    payload = json.dumps({"path": r"C:\definitely-not-a-lumendeck-model-folder"}).encode()
    status, _headers, body = build_response("POST", "/model-folder", payload)
    data = json.loads(body)
    assert status == 400
    assert "Folder does not exist" in data["error"]


def test_model_folder_accepts_folder_and_scans():
    import scanner
    import shutil
    import tempfile

    previous_home = os.environ.get("LUMENDECK_HOME")
    previous_model_dir = os.environ.get("LUMENDECK_MODEL_DIR")
    home = tempfile.mkdtemp()
    root = tempfile.mkdtemp()
    try:
        os.environ["LUMENDECK_HOME"] = home
        os.environ.pop("LUMENDECK_MODEL_DIR", None)
        open(os.path.join(root, "portrait_xl.safetensors"), "wb").write(b"model")
        payload = json.dumps({"path": root}).encode()
        status, _headers, body = build_response("POST", "/model-folder", payload)
        data = json.loads(body)
        assert status == 200
        assert data["active"] == root
        assert data["checkpointCount"] == 1
    finally:
        if previous_home is None:
            os.environ.pop("LUMENDECK_HOME", None)
        else:
            os.environ["LUMENDECK_HOME"] = previous_home
        if previous_model_dir is None:
            os.environ.pop("LUMENDECK_MODEL_DIR", None)
        else:
            os.environ["LUMENDECK_MODEL_DIR"] = previous_model_dir
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(home, ignore_errors=True)


def test_generate_returns_png_base64():
    payload = json.dumps({"prompt": "x", "seed": 5, "width": 96, "height": 96, "steps": 6}).encode()
    status, _headers, body = build_response("POST", "/generate", payload)
    assert status == 200
    out = json.loads(body)
    assert out["seed"] == 5 and out["image_base64"].startswith("iVBORw0K")


def test_unknown_route_404():
    status, _headers, _body = build_response("GET", "/nope", b"")
    assert status == 404


def test_options_preflight_cors():
    status, headers, _body = build_response("OPTIONS", "/generate", b"")
    assert status == 204 and "Access-Control-Allow-Origin" in headers


def test_models_includes_real_diffusers_entry():
    status, _headers, body = build_response("GET", "/models", b"")
    assert status == 200
    ids = [a["id"] for a in json.loads(body)]
    assert "diffusers-real" in ids


def test_progress_unknown_job_returns_unknown_phase():
    status, _headers, body = build_response("GET", "/progress/does-not-exist", b"")
    assert status == 200
    assert json.loads(body)["phase"] == "unknown"


def test_progress_rejects_invalid_job_ids():
    status, _headers, body = build_response("GET", "/progress/../../etc", b"")
    assert status == 200 and json.loads(body)["phase"] == "unknown"


def test_generate_with_job_id_reports_done():
    payload = json.dumps({"prompt": "x", "seed": 2, "width": 64, "height": 64, "steps": 4,
                          "renderer": "procedural", "jobId": "test-job-123"}).encode()
    status, _headers, _body = build_response("POST", "/generate", payload)
    assert status == 200
    p_status, _h, p_body = build_response("GET", "/progress/test-job-123", b"")
    assert p_status == 200
    assert json.loads(p_body)["phase"] == "done"


def test_resolve_targets_hub_ids():
    from server import _resolve_render_targets
    job = {"modelId": "diffusers-sdxl", "loras": []}
    _resolve_render_targets(job, [], None)
    assert job["modelRef"] == {"kind": "hub", "id": "stabilityai/sdxl-turbo"}
    job2 = {"modelId": "diffusers-real", "loras": []}
    _resolve_render_targets(job2, [], None)
    assert job2["modelRef"] == {"kind": "hub"}


def test_resolve_targets_unknown_and_demo_fall_back_to_default_hub():
    from server import _resolve_render_targets
    demo = [{"id": "ckpt-lumen-xl", "assetType": "checkpoint", "path": "models/checkpoints/nope.safetensors"}]
    job = {"modelId": "ckpt-lumen-xl", "loras": [{"id": "lora-neon-bloom", "weight": 0.7}]}
    _resolve_render_targets(job, demo, None)
    assert job["modelRef"] == {"kind": "hub"}
    assert job["loraFiles"] == []


def test_resolve_targets_scanned_files(tmp_path=None):
    import tempfile
    from server import _resolve_render_targets
    root = tempfile.mkdtemp()
    ckpt = os.path.join(root, "photoreal_xl.safetensors")
    lora = os.path.join(root, "loras", "style.safetensors")
    os.makedirs(os.path.dirname(lora), exist_ok=True)
    open(ckpt, "wb").write(b"x")
    open(lora, "wb").write(b"x")
    shelf = [
        {"id": "scan-ckpt", "assetType": "checkpoint", "path": "photoreal_xl.safetensors", "family": "SDXL"},
        {"id": "scan-lora", "assetType": "lora", "path": "loras/style.safetensors", "family": "SDXL"},
    ]
    job = {"modelId": "scan-ckpt", "loras": [{"id": "scan-lora", "weight": 0.55}]}
    _resolve_render_targets(job, shelf, root)
    assert job["modelRef"]["kind"] == "file" and job["modelRef"]["path"] == ckpt
    assert job["modelRef"]["family"] == "SDXL"
    assert job["loraFiles"] == [{"path": lora, "weight": 0.55}]


def test_models_includes_sdxl_entry():
    status, _headers, body = build_response("GET", "/models", b"")
    assets = {a["id"]: a for a in json.loads(body)}
    assert "diffusers-sdxl" in assets
    assert assets["diffusers-sdxl"]["family"] == "SDXL"


def test_diffusers_status_returns_model_status():
    status, _headers, body = build_response("GET", "/diffusers/status", b"")
    assert status == 200
    data = json.loads(body)
    assert "modelId" in data
    assert "dependenciesReady" in data


def test_diffusers_download_uses_backend_without_real_weights():
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    class FakeDiffusers:
        @staticmethod
        def model_status():
            return {"modelId": "fake/photo", "dependenciesReady": True, "loaded": False}

        @staticmethod
        def download_model():
            return {"modelId": "fake/photo", "dependenciesReady": True, "loaded": True}

    try:
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeDiffusers
        status, _headers, body = build_response("POST", "/diffusers/download", b"")
        data = json.loads(body)
        assert status == 200
        assert data["modelId"] == "fake/photo" and data["loaded"] is True
    finally:
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_diffusers_download_failure_includes_status():
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    class FakeDiffusers:
        @staticmethod
        def model_status():
            return {"modelId": "fake/photo", "dependenciesReady": False, "loaded": False}

        @staticmethod
        def download_model():
            raise RuntimeError("missing torch")

    try:
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeDiffusers
        status, _headers, body = build_response("POST", "/diffusers/download", b"")
        data = json.loads(body)
        assert status == 503
        assert "missing torch" in data["error"]
        assert data["status"]["dependenciesReady"] is False
    finally:
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


def test_diffusers_install_uses_backend_without_real_install():
    old_has = server._HAS_DIFFUSERS_MODULE
    old_backend = server.diffusers_backend

    class FakeDiffusers:
        @staticmethod
        def model_status():
            return {"modelId": "fake/photo", "dependenciesReady": False, "loaded": False}

        @staticmethod
        def install_runtime():
            return {"modelId": "fake/photo", "dependenciesReady": True, "loaded": True}

    try:
        server._HAS_DIFFUSERS_MODULE = True
        server.diffusers_backend = FakeDiffusers
        status, _headers, body = build_response("POST", "/diffusers/install", b"")
        data = json.loads(body)
        assert status == 200
        assert data["modelId"] == "fake/photo" and data["loaded"] is True
    finally:
        server._HAS_DIFFUSERS_MODULE = old_has
        server.diffusers_backend = old_backend


if __name__ == "__main__":
    test_health_reports_procedural_and_diffusers_flag()
    test_models_returns_list()
    test_model_folder_status_route()
    test_model_folder_rejects_missing_folder()
    test_model_folder_accepts_folder_and_scans()
    test_generate_returns_png_base64()
    test_unknown_route_404()
    test_options_preflight_cors()
    test_models_includes_real_diffusers_entry()
    test_progress_unknown_job_returns_unknown_phase()
    test_progress_rejects_invalid_job_ids()
    test_generate_with_job_id_reports_done()
    test_resolve_targets_hub_ids()
    test_resolve_targets_unknown_and_demo_fall_back_to_default_hub()
    test_resolve_targets_scanned_files()
    test_models_includes_sdxl_entry()
    test_diffusers_status_returns_model_status()
    test_diffusers_download_uses_backend_without_real_weights()
    test_diffusers_download_failure_includes_status()
    test_diffusers_install_uses_backend_without_real_install()
    print("bridge server: all checks passed")
