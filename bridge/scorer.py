"""Objective scoring for LumenDeck auto-evolve (Living Constellation Phase 4).

`score_images(images, prompt, weights)` scores each candidate against a concrete,
HONEST objective -- no fabricated "learned taste". Two real signals, blended per
the user-set weights:

  - CLIP similarity (real prompt adherence): lazily imports transformers
    `CLIPModel`/`CLIPProcessor` (openai/clip-vit-base-patch32), caches them
    module-global so a whole population pays the load once, and reports the cosine
    similarity of each image vs the prompt embedding, mapped to 0..1. If CLIP
    import/download fails, EVERY image gets `clip=None`, the clip weight is dropped
    (renormalized onto aesthetics), and `clip_available=False` is returned with a
    reason -- NEVER a fabricated CLIP number.
  - Aesthetic heuristics (real, deterministic, numpy): sharpness (variance of a
    Laplacian), contrast (luma std), colorfulness (Hasler-Susstrunk), and entropy,
    each normalized to 0..1 and averaged.

Return: `(results, clip_available, clip_reason)` where `results` is a per-image list
of `{"score", "clip", "aesthetic"}` (all in [0,1]; `clip` is None when unavailable),
`clip_available` is a bool, and `clip_reason` is a human string when CLIP is off
(else None). The explicit flag is what the caller surfaces as `clipAvailable`.

Heavy imports (numpy, torch, transformers, PIL) are kept lazy/in-function so nothing
in this module bloats the pure-stdlib PyInstaller sidecar. This module is the
unit-tested reference; a behaviorally identical copy is inlined in
`diffusers_backend._WORKER_SOURCE` (`_score_images`), which is what actually runs
inside the resident worker -- the same duality as `_encode_sequence`.
"""
from __future__ import annotations

import math

# Cache the CLIP model/processor for the life of the process: a population (and the
# whole evolve run) loads it once. `failed` latches so a missing/undownloadable CLIP
# is not retried on every candidate (that would be slow and noisy).
_CLIP: dict = {"model": None, "processor": None, "failed": False, "reason": None}


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _load_clip():
    """Return (model, processor) or (None, None) when CLIP can't be used.

    Lazy + cached. The first failure latches so later candidates degrade instantly
    to aesthetics-only rather than re-attempting a slow import/download each time.
    """
    if _CLIP["failed"]:
        return None, None
    if _CLIP["model"] is not None:
        return _CLIP["model"], _CLIP["processor"]
    try:
        import torch  # noqa: F401  (ensures the CLIP backend is importable)
        from transformers import CLIPModel, CLIPProcessor

        model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        model.eval()
        _CLIP["model"] = model
        _CLIP["processor"] = processor
        return model, processor
    except Exception as exc:  # import missing, weights undownloadable, etc.
        _CLIP["failed"] = True
        _CLIP["reason"] = (
            f"CLIP is unavailable ({exc}); scoring on aesthetic heuristics only."
        )
        return None, None


def _clip_scores(images, prompt):
    """Cosine(image, prompt) for each image, mapped to 0..1; or (None, reason).

    Returns (list_of_floats, None) when CLIP works, else (None, reason_string).
    """
    model, processor = _load_clip()
    if model is None:
        return None, _CLIP.get("reason")
    import torch

    with torch.no_grad():
        inputs = processor(
            text=[prompt or ""], images=list(images), return_tensors="pt", padding=True,
        )
        # Full forward -> projected embeds. This is stable across transformers
        # versions; get_image_features/get_text_features changed return type in
        # transformers 5.x (returns a BaseModelOutputWithPooling, not a tensor).
        outputs = model(**inputs)
        image_features = outputs.image_embeds
        text_features = outputs.text_embeds
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        # [N, 1] cosine similarities in [-1, 1] -> [0, 1] (monotonic, honest).
        cos = (image_features @ text_features.T).squeeze(-1)
        values = [_clamp01((float(c) + 1.0) / 2.0) for c in cos.reshape(-1)]
    return values, None


def _aesthetic_metrics(image) -> dict:
    """Deterministic aesthetic metrics for one PIL image, each normalized to 0..1."""
    import numpy as np

    arr = np.asarray(image.convert("RGB"), dtype=np.float64)
    red, green, blue = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    luma = 0.299 * red + 0.587 * green + 0.114 * blue

    # Sharpness: variance of a 3x3 Laplacian response (numpy slicing, no cv2).
    if luma.shape[0] >= 3 and luma.shape[1] >= 3:
        laplacian = (
            -4.0 * luma[1:-1, 1:-1]
            + luma[:-2, 1:-1]
            + luma[2:, 1:-1]
            + luma[1:-1, :-2]
            + luma[1:-1, 2:]
        )
        sharp_raw = float(laplacian.var())
    else:
        sharp_raw = 0.0
    sharpness = 1.0 - math.exp(-sharp_raw / 500.0)

    # Contrast: luma standard deviation, normalized against a typical spread.
    contrast = _clamp01(float(luma.std()) / 80.0)

    # Colorfulness: Hasler-Susstrunk metric.
    rg = red - green
    yb = 0.5 * (red + green) - blue
    std_root = math.sqrt(float(rg.std()) ** 2 + float(yb.std()) ** 2)
    mean_root = math.sqrt(float(rg.mean()) ** 2 + float(yb.mean()) ** 2)
    colorfulness = _clamp01((std_root + 0.3 * mean_root) / 110.0)

    # Entropy: Shannon entropy of the luma histogram, normalized by 8 bits.
    hist, _edges = np.histogram(luma, bins=256, range=(0.0, 255.0))
    total = float(hist.sum())
    if total > 0.0:
        probs = hist.astype(np.float64) / total
        nonzero = probs[probs > 0.0]
        entropy = float(-(nonzero * np.log2(nonzero)).sum())
    else:
        entropy = 0.0
    entropy_norm = _clamp01(entropy / 8.0)

    aesthetic = (sharpness + contrast + colorfulness + entropy_norm) / 4.0
    return {
        "sharpness": _clamp01(sharpness),
        "contrast": contrast,
        "colorfulness": colorfulness,
        "entropy": entropy_norm,
        "aesthetic": _clamp01(aesthetic),
    }


def _blend(clip_value, aesthetic_value, weights, clip_available) -> float:
    """Weighted blend of clip + aesthetic in [0,1].

    When CLIP is unavailable the clip weight is dropped and the score falls back to
    the aesthetic value alone (the honest degradation). When both weights are zero,
    default to an equal blend so the score is still meaningful.
    """
    weights = weights or {}
    clip_weight = max(0.0, float(weights.get("clip", 0.5)))
    aesthetic_weight = max(0.0, float(weights.get("aesthetic", 0.5)))
    if not clip_available or clip_value is None:
        return _clamp01(aesthetic_value)
    total = clip_weight + aesthetic_weight
    if total <= 0.0:
        return _clamp01((clip_value + aesthetic_value) / 2.0)
    return _clamp01((clip_weight * clip_value + aesthetic_weight * aesthetic_value) / total)


def score_images(images, prompt, weights):
    """Score each PIL image against `prompt` using the user-set `weights`.

    Returns `(results, clip_available, clip_reason)`:
      - results: list of `{"score", "clip", "aesthetic"}`, all in [0,1] (clip is None
        when CLIP is unavailable), one per input image, in order.
      - clip_available: bool -- False when CLIP couldn't load (scores use aesthetics
        only, weights renormalized).
      - clip_reason: a human string when clip_available is False, else None.
    """
    weights = weights or {}
    images = list(images)
    aesthetics = [_aesthetic_metrics(image) for image in images]
    clip_values, clip_reason = _clip_scores(images, prompt)
    clip_available = clip_values is not None

    results = []
    for index, metrics in enumerate(aesthetics):
        clip_value = clip_values[index] if clip_available else None
        score = _blend(clip_value, metrics["aesthetic"], weights, clip_available)
        results.append(
            {"score": score, "clip": clip_value, "aesthetic": metrics["aesthetic"]}
        )
    return results, clip_available, (None if clip_available else clip_reason)
