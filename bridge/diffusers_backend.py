"""Optional real text-to-image via diffusers + SD-Turbo.

Lazily imported; the bridge works fully without it. Weights download to the Hugging
Face cache on first use. Guidance is 0 and steps are low (SD-Turbo is a distilled,
few-step model), so it is usable — if slow — on CPU.
"""
from __future__ import annotations

import base64
import io

_MODEL_ID = "stabilityai/sd-turbo"
_pipe = None


def is_available() -> bool:
    try:
        import torch  # noqa: F401
        import diffusers  # noqa: F401
        return True
    except Exception:
        return False


def _load():
    global _pipe
    if _pipe is not None:
        return _pipe
    import torch
    from diffusers import AutoPipelineForText2Image

    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    pipe = AutoPipelineForText2Image.from_pretrained(_MODEL_ID, torch_dtype=dtype)
    pipe = pipe.to("cuda" if torch.cuda.is_available() else "cpu")
    _pipe = pipe
    return pipe


def generate(job: dict) -> dict:
    if not is_available():
        raise RuntimeError("diffusers/torch not installed on the bridge")
    import torch

    seed = int(job.get("seed", 0))
    if seed < 0:
        seed = 0
    pipe = _load()
    generator = torch.Generator(device=pipe.device).manual_seed(seed)
    steps = max(1, min(8, int(job.get("steps", 2))))
    image = pipe(
        prompt=str(job.get("prompt", "")),
        num_inference_steps=steps,
        guidance_scale=0.0,
        width=int(job.get("width", 512)),
        height=int(job.get("height", 512)),
        generator=generator,
    ).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"image_base64": base64.b64encode(buf.getvalue()).decode("ascii"), "seed": seed}
