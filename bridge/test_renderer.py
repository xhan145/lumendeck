"""Determinism + PNG-validity tests for the bridge renderer.

Run with pytest, or standalone: `python test_renderer.py`.
"""
import base64

from renderer import RenderRequest, render_gif_base64, render_png_base64
from scanner import demo_catalog


def test_render_is_deterministic_per_seed():
    a = render_png_base64(RenderRequest(prompt="hello", seed=42, width=128, height=128))
    b = render_png_base64(RenderRequest(prompt="hello", seed=42, width=128, height=128))
    assert a == b


def test_render_varies_with_seed():
    a = render_png_base64(RenderRequest(prompt="hello", seed=1, width=128, height=128))
    b = render_png_base64(RenderRequest(prompt="hello", seed=2, width=128, height=128))
    assert a != b


def test_output_is_a_valid_png():
    data = base64.b64decode(render_png_base64(RenderRequest(prompt="x", seed=7, width=96, height=96)))
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert b"IEND" in data[-12:]


def test_output_is_a_valid_animated_gif():
    data = base64.b64decode(render_gif_base64(RenderRequest(prompt="x", seed=7, width=96, height=96, frame_count=4, fps=8)))
    assert data[:6] == b"GIF89a"
    assert data.endswith(b";")
    assert data.count(b"\x21\xF9\x04") == 4


def test_demo_catalog_shape():
    shelf = demo_catalog()
    assert len(shelf) >= 4
    for asset in shelf:
        assert {"id", "assetType", "family", "hash", "path", "license"} <= set(asset)


if __name__ == "__main__":
    test_render_is_deterministic_per_seed()
    test_render_varies_with_seed()
    test_output_is_a_valid_png()
    test_output_is_a_valid_animated_gif()
    test_demo_catalog_shape()
    print("bridge renderer: all checks passed")
