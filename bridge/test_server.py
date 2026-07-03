import json

from server import build_response


def test_health_reports_procedural_and_diffusers_flag():
    status, _headers, body = build_response("GET", "/health", b"")
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "ok" and data["adapter"] == "procedural"
    assert "diffusers" in data


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


if __name__ == "__main__":
    test_health_reports_procedural_and_diffusers_flag()
    test_models_returns_list()
    test_generate_returns_png_base64()
    test_unknown_route_404()
    test_options_preflight_cors()
    print("bridge server: all checks passed")
