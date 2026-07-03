"""LumenDeck local render bridge (FastAPI).

Endpoints consumed by src/bridge/httpAdapter.ts:
  GET  /health   -> {"status": "ok", "adapter": "procedural"}
  GET  /models   -> ModelAsset[] (local scan or demo catalog)
  POST /generate -> {"image_base64": "...", "seed": 1234}

Run:  uvicorn main:app --host 127.0.0.1 --port 8787
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from adapters import ProceduralAdapter
from scanner import get_shelf

app = FastAPI(title="LumenDeck Bridge", version="0.1.0")

# Vite serves on an arbitrary localhost port, so allow any localhost origin.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)

adapter = ProceduralAdapter()


class LoraRef(BaseModel):
    id: str
    weight: float = 1.0


class GenerateRequest(BaseModel):
    prompt: str = ""
    negativePrompt: str = ""
    seed: int = -1
    steps: int = 28
    cfg: float = 7.0
    width: int = 512
    height: int = 512
    modelId: str | None = None
    loras: list[LoraRef] = Field(default_factory=list)
    sampler: str = "euler_a"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "adapter": adapter.id}


@app.get("/models")
def models() -> list[dict[str, Any]]:
    return get_shelf()


@app.post("/generate")
def generate(req: GenerateRequest) -> dict[str, Any]:
    return adapter.generate(req.model_dump())
