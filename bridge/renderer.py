"""Deterministic procedural image renderer using only the Python standard library.

This is a stand-in text-to-image path: it exercises the full LumenDeck render
pipeline (job -> image -> gallery -> manifest) without requiring GPU weights.
Given the same (seed, prompt, size) it always produces the same PNG, so renders
are reproducible from a manifest.
"""
from __future__ import annotations

import base64
import math
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
    frame_count: int = 1
    fps: int = 8
    motion_strength: float = 0.7
    camera_motion: str = "orbit"
    loop: bool = True


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


def _gif_lzw_encode(indices: bytes, min_code_size: int = 8) -> bytes:
    clear = 1 << min_code_size
    end = clear + 1
    code_size = min_code_size + 1
    next_code = end + 1
    dictionary = {(i,): i for i in range(clear)}
    bit_buffer = 0
    bit_count = 0
    out = bytearray()

    def emit(code: int) -> None:
        nonlocal bit_buffer, bit_count
        bit_buffer |= code << bit_count
        bit_count += code_size
        while bit_count >= 8:
            out.append(bit_buffer & 0xFF)
            bit_buffer >>= 8
            bit_count -= 8

    emit(clear)
    w: tuple[int, ...] = ()
    for raw in indices:
        k = (raw,)
        wk = w + k
        if wk in dictionary:
            w = wk
            continue
        emit(dictionary[w])
        if next_code < 4096:
            dictionary[wk] = next_code
            next_code += 1
            if next_code == (1 << code_size) and code_size < 12:
                code_size += 1
        else:
            emit(clear)
            dictionary = {(i,): i for i in range(clear)}
            code_size = min_code_size + 1
            next_code = end + 1
        w = k
    if w:
        emit(dictionary[w])
    emit(end)
    if bit_count:
        out.append(bit_buffer & 0xFF)
    return bytes(out)


def _gif_subblocks(data: bytes) -> bytes:
    out = bytearray()
    for i in range(0, len(data), 255):
        chunk = data[i:i + 255]
        out.append(len(chunk))
        out.extend(chunk)
    out.append(0)
    return bytes(out)


def _video_palette(hue_a: float, hue_b: float) -> bytes:
    palette = bytearray()
    for i in range(256):
        t = i / 255
        hue = (hue_a + (hue_b - hue_a) * t) % 360
        sat = 0.55 + 0.35 * math.sin(t * math.pi)
        light = 0.10 + 0.58 * t
        palette.extend(_hsl_to_rgb(hue, sat, light))
    return bytes(palette)


def _gif_frame_indices(req: RenderRequest, width: int, height: int, frame: int, total: int, hue_a: float, hue_b: float) -> bytes:
    phase = frame / max(1, total)
    strength = max(0.0, min(2.0, req.motion_strength))
    motion = req.camera_motion
    cx = width * (0.5 + 0.24 * strength * math.sin(phase * math.tau))
    cy = height * (0.5 + 0.18 * strength * math.cos(phase * math.tau))
    if motion == "push":
        cx, cy = width * 0.5, height * 0.5
    elif motion == "pan":
        cx = width * (0.25 + 0.5 * phase)
        cy = height * 0.5
    elif motion == "pulse":
        cx, cy = width * 0.5, height * 0.5
    radius = min(width, height) * (0.16 + 0.08 * strength + (0.08 * math.sin(phase * math.tau) if motion in ("push", "pulse") else 0))
    radius = max(8, radius)
    prompt_hash = _fnv1a(req.prompt)
    pixels = bytearray(width * height)
    for y in range(height):
        yy = y / max(1, height - 1)
        for x in range(width):
            xx = x / max(1, width - 1)
            wave = math.sin((xx * 4.0 + yy * 2.5 + phase * 2.0) * math.tau + (prompt_hash % 31))
            swirl = math.sin((xx - yy + phase * strength) * math.tau * 2.0)
            base = (xx * 0.45 + yy * 0.35 + 0.10 * wave + 0.06 * swirl + phase * 0.25) % 1.0
            dx, dy = x - cx, y - cy
            orb = max(0.0, 1.0 - ((dx * dx + dy * dy) / (radius * radius)))
            idx = int(max(0.0, min(1.0, base * 0.72 + orb * 0.42)) * 255)
            pixels[y * width + x] = idx
    return bytes(pixels)


def _gif_bytes(req: RenderRequest) -> bytes:
    width = max(64, min(512, req.width))
    height = max(64, min(512, req.height))
    frame_count = max(2, min(96, req.frame_count))
    fps = max(1, min(30, req.fps))
    rng = _mulberry32(req.seed ^ _fnv1a(req.prompt))
    hue_a = rng() * 360
    hue_b = (hue_a + 120 + rng() * 90) % 360
    delay = max(2, round(100 / fps))

    out = bytearray()
    out.extend(b"GIF89a")
    out.extend(struct.pack("<HH", width, height))
    out.extend(bytes([0xF7, 0, 0]))
    out.extend(_video_palette(hue_a, hue_b))
    if req.loop:
        out.extend(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00")
    for frame in range(frame_count):
        indices = _gif_frame_indices(req, width, height, frame, frame_count, hue_a, hue_b)
        out.extend(b"\x21\xF9\x04\x04")
        out.extend(struct.pack("<H", delay))
        out.extend(b"\x00\x00")
        out.extend(b"\x2C")
        out.extend(struct.pack("<HHHH", 0, 0, width, height))
        out.append(0)
        out.append(8)
        out.extend(_gif_subblocks(_gif_lzw_encode(indices, 8)))
    out.append(0x3B)
    return bytes(out)


def render_gif_base64(req: RenderRequest) -> str:
    """Render a deterministic procedural animated GIF and return base64."""
    return base64.b64encode(_gif_bytes(req)).decode("ascii")


def _sequence_gif_bytes(reqs: list[RenderRequest], fps: int) -> bytes:
    """Encode one procedural frame per RenderRequest into a shared-palette GIF.

    This is the motion-render FALLBACK path: each request is a distinct frame from a
    keyframe sweep (e.g. cfg 4→18→7), so the frames must visibly differ. Each frame's
    index map is derived from THAT request's (seed, prompt, cfg), which drives the
    orb density/spread — the same knobs the still renderer uses — so a cfg sweep
    animates. The palette is taken from the first frame so playback is coherent.
    """
    if not reqs:
        raise ValueError("cannot encode a sequence with zero frames")
    first = reqs[0]
    width = max(64, min(512, first.width))
    height = max(64, min(512, first.height))
    fps = max(1, min(30, fps))
    delay = max(2, round(100 / fps))
    rng = _mulberry32(first.seed ^ _fnv1a(first.prompt))
    hue_a = rng() * 360
    hue_b = (hue_a + 120 + rng() * 90) % 360

    out = bytearray()
    out.extend(b"GIF89a")
    out.extend(struct.pack("<HH", width, height))
    out.extend(bytes([0xF7, 0, 0]))
    out.extend(_video_palette(hue_a, hue_b))
    if first.loop:
        out.extend(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00")
    total = len(reqs)
    for index, req in enumerate(reqs):
        # Per-frame hue seeded from that frame's request so a param sweep shifts color.
        frng = _mulberry32(req.seed ^ _fnv1a(req.prompt))
        fh_a = frng() * 360
        fh_b = (fh_a + 120 + frng() * 90) % 360
        # cfg drives the motion phase so cfg 4→18→7 produces a visibly changing frame.
        strength = max(0.0, min(2.0, req.cfg / 9.0))
        frame_req = RenderRequest(
            prompt=req.prompt, seed=req.seed, width=width, height=height,
            cfg=req.cfg, motion_strength=strength, camera_motion=req.camera_motion,
        )
        indices = _gif_frame_indices(frame_req, width, height, index, total, fh_a, fh_b)
        out.extend(b"\x21\xF9\x04\x04")
        out.extend(struct.pack("<H", delay))
        out.extend(b"\x00\x00")
        out.extend(b"\x2C")
        out.extend(struct.pack("<HHHH", 0, 0, width, height))
        out.append(0)
        out.append(8)
        out.extend(_gif_subblocks(_gif_lzw_encode(indices, 8)))
    out.append(0x3B)
    return bytes(out)


def render_sequence_gif_base64(reqs: list[RenderRequest], fps: int = 8) -> str:
    """Render one procedural frame per request and return a base64 animated GIF."""
    return base64.b64encode(_sequence_gif_bytes(reqs, fps)).decode("ascii")
