import json

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


if __name__ == "__main__":
    test_health_reports_procedural_and_diffusers_flag()
    test_models_returns_list()
    test_generate_returns_png_base64()
    test_unknown_route_404()
    test_options_preflight_cors()
    test_diffusers_status_returns_model_status()
    test_diffusers_download_uses_backend_without_real_weights()
    test_diffusers_download_failure_includes_status()
    print("bridge server: all checks passed")
