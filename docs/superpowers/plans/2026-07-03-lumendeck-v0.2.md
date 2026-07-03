# LumenDeck v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, same
> session — user waived review gates: "no further intervention needed").

**Goal:** A single MSI that auto-launches a bundled bridge and can produce real images, plus
`.lumen` recipe save/load and a starter-template gallery.

**Architecture:** Rewrite the bridge as a pure-stdlib HTTP server so PyInstaller freezes it
into a dependency-free sidecar exe that Tauri spawns on launch. Add an optional lazy
`diffusers`/SD-Turbo path alongside the guaranteed procedural renderer and the existing
ComfyUI adapter. Add a pure-TS `.lumen` codec + built-in templates on the front end.

**Tech Stack:** Python 3 stdlib (`http.server`), PyInstaller, Tauri v2 + `tauri-plugin-shell`,
React/TS, Vitest.

## Global Constraints
- App name **LumenDeck**; bump versions to `0.2.0` (package.json, tauri.conf.json, Cargo.toml,
  storeConstants `APP_VERSION`).
- Bridge sidecar must have **zero third-party Python deps** (stdlib only); `diffusers`/`torch`
  imported lazily and optionally.
- Default bridge port **8787**; `/health` → `{"status":"ok","adapter":"procedural","diffusers":bool}`.
- Procedural renderer is the guaranteed fallback; never let a missing real backend crash a render.
- `.lumen` schema: `{ schemaVersion:1, app:'LumenDeck', savedAt, workflow, rackPresets }`.
- Keep all existing tests green. TDD for pure logic; commit per task.

---

### Task 1: Stdlib bridge server (replaces FastAPI)
**Files:** Create `bridge/server.py`; Modify `bridge/adapters.py` (unchanged API), remove reliance
on `bridge/main.py` (keep file but mark deprecated in `bridge/README.md`); Test `bridge/test_server.py`.
**Interfaces produced:**
- `build_response(method, path, body: bytes) -> tuple[int, dict, bytes]` — pure dispatch used by tests and the handler.
- `run(port: int)` — starts `ThreadingHTTPServer`.
- `main(argv)` — parses `--port`/`PORT` env (default 8787), calls `run`.

- [ ] **Step 1: Failing test** — `bridge/test_server.py`:
```python
import json
from server import build_response

def test_health_reports_procedural_and_diffusers_flag():
    status, headers, body = build_response("GET", "/health", b"")
    assert status == 200
    data = json.loads(body)
    assert data["status"] == "ok" and data["adapter"] == "procedural"
    assert "diffusers" in data

def test_models_returns_list():
    status, _h, body = build_response("GET", "/models", b"")
    assert status == 200 and isinstance(json.loads(body), list)

def test_generate_returns_png_base64():
    payload = json.dumps({"prompt": "x", "seed": 5, "width": 96, "height": 96, "steps": 6}).encode()
    status, _h, body = build_response("POST", "/generate", payload)
    assert status == 200
    out = json.loads(body)
    assert out["seed"] == 5 and out["image_base64"].startswith("iVBORw0K")

def test_unknown_route_404():
    status, _h, _b = build_response("GET", "/nope", b"")
    assert status == 404

def test_options_preflight_cors():
    status, headers, _b = build_response("OPTIONS", "/generate", b"")
    assert status == 204 and "Access-Control-Allow-Origin" in headers
```
- [ ] **Step 2: Run, expect fail** — `cd bridge && python -m pytest test_server.py -q` → ModuleNotFoundError: server.
- [ ] **Step 3: Implement** `bridge/server.py`:
```python
"""Pure-stdlib LumenDeck bridge (no third-party deps) for PyInstaller bundling."""
from __future__ import annotations
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from renderer import RenderRequest, render_png_base64
from scanner import get_shelf
try:
    import diffusers_backend
    _HAS_DIFFUSERS_MODULE = True
except Exception:
    _HAS_DIFFUSERS_MODULE = False

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

def _diffusers_available() -> bool:
    return _HAS_DIFFUSERS_MODULE and diffusers_backend.is_available()

def _procedural(job: dict) -> dict:
    seed = int(job.get("seed", 0))
    if seed < 0:
        seed = abs(hash(job.get("prompt", ""))) % 0xFFFFFFFF
    req = RenderRequest(
        prompt=str(job.get("prompt", "")), seed=seed,
        width=int(job.get("width", 512)), height=int(job.get("height", 512)),
        steps=int(job.get("steps", 28)), cfg=float(job.get("cfg", 7.0)),
        loras=len(job.get("loras", []) or []),
    )
    return {"image_base64": render_png_base64(req), "seed": seed}

def build_response(method: str, path: str, body: bytes):
    headers = dict(CORS)
    if method == "OPTIONS":
        return 204, headers, b""
    if method == "GET" and path == "/health":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps({"status": "ok", "adapter": "procedural", "diffusers": _diffusers_available()}).encode()
    if method == "GET" and path == "/models":
        headers["Content-Type"] = "application/json"
        return 200, headers, json.dumps(get_shelf()).encode()
    if method == "POST" and path == "/generate":
        headers["Content-Type"] = "application/json"
        try:
            job = json.loads(body or b"{}")
        except json.JSONDecodeError:
            return 400, headers, json.dumps({"error": "invalid JSON"}).encode()
        mode = str(job.get("renderer", "auto"))
        if mode in ("diffusers", "auto") and _diffusers_available():
            try:
                return 200, headers, json.dumps(diffusers_backend.generate(job)).encode()
            except Exception as exc:  # fall back to procedural on any inference error
                if mode == "diffusers":
                    return 503, headers, json.dumps({"error": f"diffusers failed: {exc}"}).encode()
        if mode == "diffusers" and not _diffusers_available():
            return 503, headers, json.dumps({"error": "diffusers/torch not installed on the bridge"}).encode()
        return 200, headers, json.dumps(_procedural(job)).encode()
    return 404, headers, json.dumps({"error": "not found"}).encode()

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, headers, body):
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
    def do_OPTIONS(self): self._send(*build_response("OPTIONS", self.path, b""))
    def do_GET(self): self._send(*build_response("GET", self.path, b""))
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self._send(*build_response("POST", self.path, self.rfile.read(length)))
    def log_message(self, *_args): pass

def run(port: int) -> None:
    print(f"LumenDeck bridge on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

def main(argv=None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    port = int(os.environ.get("PORT", "8787"))
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    run(port)

if __name__ == "__main__":
    main()
```
- [ ] **Step 4: Run, expect pass** — `python -m pytest test_server.py -q` → 5 passed.
- [ ] **Step 5: Commit** — `git add bridge && git commit -m "feat(bridge): pure-stdlib http server for sidecar bundling"`

---

### Task 2: Optional diffusers backend (lazy SD-Turbo)
**Files:** Create `bridge/diffusers_backend.py`; Test `bridge/test_diffusers_backend.py`.
**Interfaces produced:** `is_available() -> bool`; `generate(job: dict) -> dict` (`{image_base64, seed}`).

- [ ] **Step 1: Failing test** — availability is False when torch absent, and reflects import state:
```python
import diffusers_backend as db

def test_is_available_is_bool():
    assert isinstance(db.is_available(), bool)

def test_generate_raises_clearly_when_unavailable():
    if db.is_available():
        return  # torch present; skip negative test
    try:
        db.generate({"prompt": "x", "seed": 1})
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "diffusers" in str(exc).lower() or "torch" in str(exc).lower()
```
- [ ] **Step 2: Run, expect fail** — `python -m pytest test_diffusers_backend.py -q` → ModuleNotFoundError.
- [ ] **Step 3: Implement** `bridge/diffusers_backend.py`:
```python
"""Optional real text-to-image via diffusers + SD-Turbo. Lazily imported; the bridge
works without it. Weights download to the Hugging Face cache on first use."""
from __future__ import annotations
import base64, io

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
    gen = torch.Generator(device=pipe.device).manual_seed(seed)
    steps = max(1, min(8, int(job.get("steps", 2))))
    image = pipe(
        prompt=str(job.get("prompt", "")),
        num_inference_steps=steps,
        guidance_scale=0.0,
        width=int(job.get("width", 512)),
        height=int(job.get("height", 512)),
        generator=gen,
    ).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"image_base64": base64.b64encode(buf.getvalue()).decode("ascii"), "seed": seed}
```
- [ ] **Step 4: Run, expect pass** — `python -m pytest test_diffusers_backend.py -q` → passes (torch absent → negative branch).
- [ ] **Step 5: Commit** — `git add bridge && git commit -m "feat(bridge): optional lazy diffusers SD-Turbo backend"`

---

### Task 3: Sidecar packaging script
**Files:** Create `bridge/build_sidecar.py`; Modify `bridge/README.md` (bundling section);
Create `src-tauri/binaries/.gitkeep`.
**Interfaces produced:** running `python bridge/build_sidecar.py` writes
`src-tauri/binaries/lumendeck-bridge-x86_64-pc-windows-msvc.exe`.

- [ ] **Step 1: Implement** `bridge/build_sidecar.py`:
```python
"""Freeze the stdlib bridge into a Tauri sidecar exe via PyInstaller.
Usage: python build_sidecar.py   (run from repo root or bridge/)."""
import os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET_TRIPLE = "x86_64-pc-windows-msvc"
OUT_DIR = os.path.join(ROOT, "src-tauri", "binaries")

def main():
    subprocess.check_call([sys.executable, "-m", "PyInstaller", "--onefile", "--name",
                           "lumendeck-bridge", "--distpath", os.path.join(HERE, "dist"),
                           "--workpath", os.path.join(HERE, "build"),
                           "--specpath", HERE,
                           os.path.join(HERE, "server.py")])
    os.makedirs(OUT_DIR, exist_ok=True)
    src = os.path.join(HERE, "dist", "lumendeck-bridge.exe")
    dst = os.path.join(OUT_DIR, f"lumendeck-bridge-{TARGET_TRIPLE}.exe")
    shutil.copy2(src, dst)
    print("sidecar ->", dst)

if __name__ == "__main__":
    main()
```
- [ ] **Step 2: Run it** — `python bridge/build_sidecar.py` (installs nothing else; needs `pip install pyinstaller`). Expected: prints `sidecar -> .../lumendeck-bridge-x86_64-pc-windows-msvc.exe`.
- [ ] **Step 3: Smoke the frozen exe** — start it and curl:
```
src-tauri/binaries/lumendeck-bridge-x86_64-pc-windows-msvc.exe --port 8799 &
curl -s http://127.0.0.1:8799/health   # -> {"status":"ok",...}
```
- [ ] **Step 4: Add `.gitkeep`** so `src-tauri/binaries/` exists; gitignore the frozen exe (large) in `src-tauri/.gitignore` (`binaries/*.exe`), keep the build script tracked.
- [ ] **Step 5: Commit** — `git add bridge/build_sidecar.py src-tauri/binaries/.gitkeep src-tauri/.gitignore bridge/README.md && git commit -m "build(bridge): PyInstaller sidecar packaging"`

---

### Task 4: Tauri spawns the sidecar
**Files:** Modify `src-tauri/Cargo.toml` (add `tauri-plugin-shell`), `src-tauri/src/main.rs`
(spawn in setup), `src-tauri/tauri.conf.json` (`bundle.externalBin`),
`src-tauri/capabilities/default.json` (shell execute-sidecar permission).
**Interfaces produced:** on app launch the bridge runs on 8787 and is killed on exit.

- [ ] **Step 1: Cargo dep** — add to `[dependencies]`: `tauri-plugin-shell = "2"`.
- [ ] **Step 2: tauri.conf.json** — add under `bundle`:
```json
"externalBin": ["binaries/lumendeck-bridge"]
```
- [ ] **Step 3: capabilities/default.json** — add permissions:
```json
"permissions": ["core:default", "shell:allow-execute", { "identifier": "shell:allow-spawn", "allow": [{ "name": "binaries/lumendeck-bridge", "sidecar": true }] }]
```
- [ ] **Step 4: main.rs** — spawn on setup:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(cmd) = handle.shell().sidecar("lumendeck-bridge") {
                if let Ok((mut rx, _child)) = cmd.args(["--port", "8787"]).spawn() {
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = event {
                                let _ = String::from_utf8(line);
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running LumenDeck");
}
```
- [ ] **Step 5: Build check** — `cd src-tauri && cargo build 2>&1 | tail -5` → Finished (dev). Commit:
`git add src-tauri && git commit -m "feat(desktop): auto-spawn bridge sidecar on launch"`

---

### Task 5: Front-end bridge auto-select + renderer mode
**Files:** Modify `src/state/store.ts` (`probeBridge` retry/backoff + auto-select;
thread `renderer` into the job), `src/bridge/httpAdapter.ts` (send `renderer`),
`src/turboForge/backends/backendSettings.ts` (add `bridgeRenderer` field),
`src/components/BackendSettingsPanel.tsx` (mode select); Test `tests/bridgeRenderer.test.ts`.
**Interfaces consumed:** `HttpAdapter.generate(job)` (Task exists); `BackendSettings`.
**Interfaces produced:** `BackendSettings.bridgeRenderer: 'procedural'|'diffusers'|'auto'`.

- [ ] **Step 1: Failing test** — `tests/bridgeRenderer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { sanitizeBackendSettings, DEFAULT_BACKEND_SETTINGS } from '../src/turboForge/backends/backendSettings';

describe('bridgeRenderer setting', () => {
  it('defaults to auto', () => {
    expect(DEFAULT_BACKEND_SETTINGS.bridgeRenderer).toBe('auto');
  });
  it('rejects invalid values back to auto', () => {
    const s = sanitizeBackendSettings({ ...DEFAULT_BACKEND_SETTINGS, bridgeRenderer: 'bogus' as never });
    expect(s.bridgeRenderer).toBe('auto');
  });
});
```
- [ ] **Step 2: Run, expect fail** — `npx vitest run tests/bridgeRenderer.test.ts` → fails (field undefined).
- [ ] **Step 3: Implement** — add `bridgeRenderer` to `BackendSettings` type + `DEFAULT_BACKEND_SETTINGS` (`'auto'`) + clamp in `sanitizeBackendSettings` (allowed set `['procedural','diffusers','auto']`, else `'auto'`). In `httpAdapter.ts` `generate`, include `renderer` in the POST body (add optional `renderer?: string` to the call site; store passes `get().backendSettings.bridgeRenderer`). In `store.ts` `enqueueRender`, when building the job for the http adapter, attach `renderer`. In `BackendSettingsPanel.tsx`, add a `<select>` bound to `bridgeRenderer` shown when `selectedBackend==='bridge'`.
- [ ] **Step 4: probeBridge backoff** — in `store.ts`, make `probeBridge` try up to 5 times with 1s spacing; on success set `bridgeOnline:true` and, if the user has not explicitly changed backend this session, `setAdapter('bridge')`. Guard with a `bridgeAutoSelected` flag so it doesn't override manual choice.
- [ ] **Step 5: Run tests + typecheck** — `npx vitest run tests/bridgeRenderer.test.ts && npx tsc --noEmit` → pass. Commit:
`git add src tests && git commit -m "feat: bridge auto-select + renderer mode (procedural/diffusers/auto)"`

---

### Task 6: `.lumen` codec (pure TS, TDD)
**Files:** Create `src/core/lumenFile.ts`; Test `tests/lumenFile.test.ts`.
**Interfaces consumed:** `Workflow`, `RackPreset` from `core/types`.
**Interfaces produced:**
- `interface LumenFile { schemaVersion: 1; app: 'LumenDeck'; savedAt: string; workflow: Workflow; rackPresets: RackPreset[] }`
- `buildLumenFile(workflow, rackPresets, now: Date): LumenFile`
- `parseLumenFile(text: string): { ok: true; file: LumenFile } | { ok: false; error: string }`

- [ ] **Step 1: Failing test** — `tests/lumenFile.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildLumenFile, parseLumenFile } from '../src/core/lumenFile';
import { createDefaultWorkflow } from '../src/core/workflow';

describe('lumenFile', () => {
  const wf = createDefaultWorkflow();
  it('round-trips workflow through export/import', () => {
    const text = JSON.stringify(buildLumenFile(wf, [], new Date('2026-07-03T00:00:00Z')));
    const res = parseLumenFile(text);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.file.workflow.nodes.length).toBe(wf.nodes.length);
  });
  it('rejects malformed JSON', () => {
    expect(parseLumenFile('{not json').ok).toBe(false);
  });
  it('rejects wrong schemaVersion', () => {
    const bad = JSON.stringify({ schemaVersion: 99, app: 'LumenDeck', workflow: wf, rackPresets: [] });
    const res = parseLumenFile(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/schema/i);
  });
  it('rejects missing workflow shape', () => {
    const res = parseLumenFile(JSON.stringify({ schemaVersion: 1, app: 'LumenDeck', rackPresets: [] }));
    expect(res.ok).toBe(false);
  });
});
```
- [ ] **Step 2: Run, expect fail** — `npx vitest run tests/lumenFile.test.ts` → module missing.
- [ ] **Step 3: Implement** `src/core/lumenFile.ts`:
```ts
import type { RackPreset, Workflow } from './types';

export interface LumenFile {
  schemaVersion: 1;
  app: 'LumenDeck';
  savedAt: string;
  workflow: Workflow;
  rackPresets: RackPreset[];
}

export function buildLumenFile(workflow: Workflow, rackPresets: RackPreset[], now: Date): LumenFile {
  return { schemaVersion: 1, app: 'LumenDeck', savedAt: now.toISOString(), workflow, rackPresets };
}

function isWorkflow(w: unknown): w is Workflow {
  if (!w || typeof w !== 'object') return false;
  const c = w as Record<string, unknown>;
  return Array.isArray(c.nodes) && Array.isArray(c.edges) && typeof c.version === 'number';
}

export function parseLumenFile(text: string): { ok: true; file: LumenFile } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not a valid .lumen file (invalid JSON).' };
  }
  const d = data as Record<string, unknown>;
  if (d.schemaVersion !== 1) return { ok: false, error: `Unsupported .lumen schema version: ${String(d.schemaVersion)}.` };
  if (!isWorkflow(d.workflow)) return { ok: false, error: 'The .lumen file has no valid workflow.' };
  const rackPresets = Array.isArray(d.rackPresets) ? (d.rackPresets as RackPreset[]) : [];
  return { ok: true, file: { schemaVersion: 1, app: 'LumenDeck', savedAt: String(d.savedAt ?? ''), workflow: d.workflow, rackPresets } };
}
```
- [ ] **Step 4: Run, expect pass** — `npx vitest run tests/lumenFile.test.ts` → 4 passed.
- [ ] **Step 5: Commit** — `git add src/core/lumenFile.ts tests/lumenFile.test.ts && git commit -m "feat: .lumen recipe codec with validation"`

---

### Task 7: Starter templates (TDD)
**Files:** Create `src/data/templates.ts`; Test `tests/templates.test.ts`.
**Interfaces consumed:** `Workflow`, `createDefaultWorkflow`, `updateNodeParam`, `findNode`, `checkHealth`, `DEMO_SHELF`.
**Interfaces produced:** `interface RecipeTemplate { id: string; name: string; description: string; build(): Workflow }`; `TEMPLATES: RecipeTemplate[]`.

- [ ] **Step 1: Failing test** — `tests/templates.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../src/data/templates';
import { checkHealth } from '../src/core/health';
import { DEMO_SHELF } from '../src/data/demoShelf';

describe('starter templates', () => {
  it('ships at least three', () => { expect(TEMPLATES.length).toBeGreaterThanOrEqual(3); });
  it('each builds a health-clean workflow with an installed checkpoint', () => {
    for (const t of TEMPLATES) {
      const wf = t.build();
      const errors = checkHealth(wf, DEMO_SHELF).filter((i) => i.severity === 'error');
      expect(errors, `${t.name}: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
    }
  });
  it('has unique ids', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });
});
```
- [ ] **Step 2: Run, expect fail** — `npx vitest run tests/templates.test.ts` → module missing.
- [ ] **Step 3: Implement** `src/data/templates.ts` — build on `createDefaultWorkflow()` then set params via `updateNodeParam(findNode(...))`; each sets `model.assetId` to an **installed** checkpoint from `DEMO_SHELF` (`ckpt-lumen-xl` for SDXL, `ckpt-drift-15` for SD1.5) and a prompt/sampler/canvas fitting the style. Provide `neon-poster`, `ink-sketch`, `portrait-studio`:
```ts
import { checkHealth } from '../core/health'; // (not imported in impl; example only)
import { createDefaultWorkflow, findNode, updateNodeParam } from '../core/workflow';
import type { Workflow } from '../core/types';

export interface RecipeTemplate { id: string; name: string; description: string; build(): Workflow }

function base(apply: (wf: Workflow) => Workflow): Workflow {
  let wf = createDefaultWorkflow();
  const model = findNode(wf, 'model')!;
  wf = updateNodeParam(wf, model.id, 'assetId', 'ckpt-lumen-xl');
  return apply(wf);
}
function setPrompt(wf: Workflow, positive: string, negative = 'blurry, low quality'): Workflow {
  const p = findNode(wf, 'prompt')!;
  return updateNodeParam(updateNodeParam(wf, p.id, 'positive', positive), p.id, 'negative', negative);
}
function setSampler(wf: Workflow, steps: number, cfg: number): Workflow {
  const s = findNode(wf, 'sampler')!;
  return updateNodeParam(updateNodeParam(wf, s.id, 'steps', steps), s.id, 'cfg', cfg);
}

export const TEMPLATES: RecipeTemplate[] = [
  { id: 'neon-poster', name: 'Neon Poster', description: 'High-contrast neon key art.',
    build: () => base((wf) => setSampler(setPrompt(wf, 'neon cyberpunk poster, glowing signage, rain, cinematic, ultra detailed'), 30, 8)) },
  { id: 'ink-sketch', name: 'Ink Sketch', description: 'Monochrome ink-wash study.',
    build: () => base((wf) => { let w = updateNodeParam(wf, findNode(wf, 'model')!.id, 'assetId', 'ckpt-drift-15'); w = setPrompt(w, 'sumi-e ink wash sketch, minimal, high contrast, paper texture'); return setSampler(w, 22, 6); }) },
  { id: 'portrait-studio', name: 'Portrait Studio', description: 'Soft-lit studio portrait.',
    build: () => base((wf) => setSampler(setPrompt(wf, 'studio portrait, soft rim light, 85mm, shallow depth of field, photoreal'), 28, 7)) },
];
```
(Remove the unused `checkHealth` import — that line is illustrative; the impl imports only workflow helpers + types.)
- [ ] **Step 4: Run, expect pass** — `npx vitest run tests/templates.test.ts` → 3 passed.
- [ ] **Step 5: Commit** — `git add src/data/templates.ts tests/templates.test.ts && git commit -m "feat: starter recipe templates"`

---

### Task 8: Recipe save/load + templates UI
**Files:** Create `src/components/recipe/RecipeActions.tsx` (Save/Open/Templates buttons +
templates modal); Modify `src/components/recipe/RecipeView.tsx` (mount actions),
`src/state/store.ts` (add `loadWorkflowFile(file: LumenFile)` + `applyTemplate(id)`).
**Interfaces consumed:** `buildLumenFile`, `parseLumenFile`, `downloadJson`, `TEMPLATES`.
**Interfaces produced:** store `loadWorkflowFile(file)`, `applyTemplate(id)`.

- [ ] **Step 1: store actions** — in `store.ts`:
```ts
loadWorkflowFile: (file) => {
  commit(file.workflow);
  if (file.rackPresets?.length) set({ rackPresets: file.rackPresets });
  set({ selectedNodeId: null, view: 'recipe' });
},
applyTemplate: (id) => {
  const t = TEMPLATES.find((x) => x.id === id);
  if (t) { commit(t.build()); set({ selectedNodeId: null, view: 'recipe' }); }
},
```
(add imports for `TEMPLATES` and the `LumenFile` type; declare both in the `StudioState` interface.)
- [ ] **Step 2: RecipeActions.tsx** — Save button: `downloadJson(buildLumenFile(workflow, rackPresets, new Date()), \`${slugify(name)||'recipe'}.lumen\`)`; Open button: hidden `<input type="file" accept=".lumen,.json">` → read text → `parseLumenFile` → on ok `loadWorkflowFile(res.file)`, on error show an inline message; Templates button opens a modal listing `TEMPLATES` (name + description + Apply → `applyTemplate(id)`). Reuse `.drawer`/`.chip`/`.btn` styles.
- [ ] **Step 3: Mount** in `RecipeView.tsx` header area (above the intro paragraph).
- [ ] **Step 4: Verify in preview** — start preview, Save downloads a `.lumen`; Templates → Apply swaps the workflow; Open re-imports. Confirm no console errors.
- [ ] **Step 5: Typecheck + commit** — `npx tsc --noEmit` then
`git add src && git commit -m "feat: recipe save/load + template gallery UI"`

---

### Task 9: Version bump, docs, MSI rebuild, verification
**Files:** Modify `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`src/state/storeConstants.ts` (→ `0.2.0`); `README.md`, `RELEASE_NOTES.md`.
- [ ] **Step 1: Bump** all four version strings to `0.2.0`.
- [ ] **Step 2: Full test + typecheck** — `npx vitest run && npx tsc --noEmit` → all green.
- [ ] **Step 3: Build sidecar then MSI** — `python bridge/build_sidecar.py` then `npm run tauri build`; confirm `src-tauri/target/release/bundle/msi/LumenDeck_0.2.0_x64_en-US.msi` exists and the bundle includes the sidecar.
- [ ] **Step 4: Docs** — README: bundled-bridge + renderer modes + recipe save/load/templates; RELEASE_NOTES v0.2.0 with the honest verification note (procedural + wiring verified; real SD-Turbo weights not verified here).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: v0.2.0 — bundled bridge MSI, real diffusion modes, recipe portability + docs"`

## Self-review
- **Spec coverage:** M1 sidecar = Tasks 1,3,4,5; M2 real diffusion = Tasks 2,5 (+ existing ComfyUI); M3 save/load+templates = Tasks 6,7,8. Version/docs/MSI = Task 9. ✓
- **Placeholders:** none — all code shown; the one illustrative `checkHealth` import in Task 7 is explicitly flagged for removal. ✓
- **Type consistency:** `LumenFile`, `parseLumenFile`, `buildLumenFile`, `RecipeTemplate`/`TEMPLATES`,
  `bridgeRenderer` union, `loadWorkflowFile`/`applyTemplate` names used identically across tasks. ✓
- **Risk:** PyInstaller + `tauri-plugin-shell` sidecar permission schema are the two unknowns; Tasks 3–4 isolate them so failures are contained. Diffusers real inference intentionally unverified (stated).
