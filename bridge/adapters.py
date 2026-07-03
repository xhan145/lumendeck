"""Generator adapters for the bridge.

The bridge ships a ProceduralAdapter (pure stdlib, always available). The
A1111Adapter is a documented stub showing where a real AUTOMATIC1111 /
Stable Diffusion WebUI backend would plug in — implement `generate` against its
`/sdapi/v1/txt2img` endpoint to enable true diffusion.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from renderer import RenderRequest, render_png_base64


class GeneratorAdapter(ABC):
    id: str = "abstract"
    label: str = "Abstract"

    @abstractmethod
    def generate(self, job: dict) -> dict:
        """Return {'image_base64': str, 'seed': int}."""
        raise NotImplementedError


class ProceduralAdapter(GeneratorAdapter):
    id = "procedural"
    label = "Procedural (stdlib)"

    def generate(self, job: dict) -> dict:
        seed = int(job.get("seed", 0))
        if seed < 0:
            # Deterministic-ish fallback derived from the prompt, avoids RNG import.
            seed = abs(hash(job.get("prompt", ""))) % 0xFFFFFFFF
        req = RenderRequest(
            prompt=str(job.get("prompt", "")),
            seed=seed,
            width=int(job.get("width", 512)),
            height=int(job.get("height", 512)),
            steps=int(job.get("steps", 28)),
            cfg=float(job.get("cfg", 7.0)),
            loras=len(job.get("loras", []) or []),
        )
        return {"image_base64": render_png_base64(req), "seed": seed}


class A1111Adapter(GeneratorAdapter):
    """Stub: wire this to a running AUTOMATIC1111 WebUI for real generation."""

    id = "a1111"
    label = "AUTOMATIC1111 (stub)"

    def __init__(self, base_url: str = "http://127.0.0.1:7860") -> None:
        self.base_url = base_url

    def generate(self, job: dict) -> dict:  # pragma: no cover - documented stub
        raise NotImplementedError(
            "A1111Adapter is a stub. Implement a POST to "
            f"{self.base_url}/sdapi/v1/txt2img mapping the LumenDeck job fields "
            "(prompt, negativePrompt->negative_prompt, steps, cfg->cfg_scale, "
            "width, height, seed) and return the base64 image it responds with."
        )
