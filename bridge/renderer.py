"""Deterministic procedural image renderer using only the Python standard library.

This is a stand-in text-to-image path: it exercises the full LumenDeck render
pipeline (job -> image -> gallery -> manifest) without requiring GPU weights.
Given the same (seed, prompt, size) it always produces the same PNG, so renders
are reproducible from a manifest.
"""
from __future__ import annotations

import base64
import struct
import zlib
from dataclasses import dataclass


def _mulberry32(seed: int):
    """Match the front-end MockAdapter PRNG family for familiar behaviour."""
    a = seed & 0xFFFFFFFF

    def rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (t ^ (t >> 15)) * (1 | t) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def _fnv1a(text: str) -> int:
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _hsl_to_rgb(h: float, s: float, l: float) -> tuple[int, int, int]:
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = l - c / 2
    if h < 60:
        r, g, b = c, x, 0
    elif h < 120:
        r, g, b = x, c, 0
    elif h < 180:
        r, g, b = 0, c, x
    elif h < 240:
        r, g, b = 0, x, c
    elif h < 300:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    return (int((r + m) * 255), int((g + m) * 255), int((b + m) * 255))


def _png_bytes(width: int, height: int, pixels: bytearray) -> bytes:
    """Encode raw RGB pixels (row-major, 3 bytes/pixel) as a PNG."""
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(pixels[y * stride:(y + 1) * stride])
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", ihdr),
        chunk(b"IDAT", compressed),
        chunk(b"IEND", b""),
    ])


@dataclass
class RenderRequest:
    prompt: str = ""
    seed: int = 0
    width: int = 512
    height: int = 512
    steps: int = 28
    cfg: float = 7.0
    loras: int = 0


def render_png_base64(req: RenderRequest) -> str:
    """Render a deterministic procedural PNG and return base64 (no data: prefix)."""
    # Clamp to a sane server-side ceiling to keep pure-Python rendering fast.
    w = max(64, min(1024, req.width))
    h = max(64, min(1024, req.height))
    rng = _mulberry32(req.seed ^ _fnv1a(req.prompt))

    hue_a = rng() * 360
    hue_b = (hue_a + 120 + rng() * 90) % 360
    top = _hsl_to_rgb(hue_a, 0.7, 0.14)
    bottom = _hsl_to_rgb(hue_b, 0.65, 0.22)

    # Diagonal gradient background.
    pixels = bytearray(w * h * 3)
    for y in range(h):
        for x in range(w):
            t = (x + y) / (w + h)
            idx = (y * w + x) * 3
            pixels[idx] = int(top[0] + (bottom[0] - top[0]) * t)
            pixels[idx + 1] = int(top[1] + (bottom[1] - top[1]) * t)
            pixels[idx + 2] = int(top[2] + (bottom[2] - top[2]) * t)

    # Glow orbs; density scales with steps, spread with cfg (mirrors MockAdapter).
    orbs = min(140, 20 + req.steps * 2)
    for _ in range(orbs):
        cx = rng() * w
        cy = rng() * h
        radius = (0.02 + rng() * 0.12 * min(3.0, req.cfg / 5)) * min(w, h)
        hue = hue_a if rng() > 0.5 else hue_b
        oc = _hsl_to_rgb(hue, 0.9, 0.65)
        r2 = radius * radius
        x0, x1 = max(0, int(cx - radius)), min(w, int(cx + radius))
        y0, y1 = max(0, int(cy - radius)), min(h, int(cy + radius))
        for y in range(y0, y1):
            for x in range(x0, x1):
                d2 = (x - cx) ** 2 + (y - cy) ** 2
                if d2 > r2:
                    continue
                a = (1 - (d2 / r2)) * 0.55
                idx = (y * w + x) * 3
                pixels[idx] = min(255, int(pixels[idx] + oc[0] * a))
                pixels[idx + 1] = min(255, int(pixels[idx + 1] + oc[1] * a))
                pixels[idx + 2] = min(255, int(pixels[idx + 2] + oc[2] * a))

    return base64.b64encode(_png_bytes(w, h, pixels)).decode("ascii")
