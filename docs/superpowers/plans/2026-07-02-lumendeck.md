# LumenDeck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline execution
> chosen — same session as plan author, so interface blocks replace duplicated code listings).

**Goal:** Local-first node-native generative image studio with synced Recipe and Graph views.

**Architecture:** Pure-TS core (`src/core`) holding one immutable `Workflow` object; Zustand store
projects it into both views; adapters isolate rendering backends; Python FastAPI bridge provides a
real local text-to-image path (deterministic stdlib PNG renderer) and a model scanner.

**Tech Stack:** Vite 6, React 18, TypeScript 5 (strict), Zustand 5, Vitest 3; Python 3.14 + FastAPI + uvicorn.

## Global Constraints

- App name everywhere: **LumenDeck**. Version `0.1.0` surfaced in manifest as `appVersion`.
- Palette (verbatim): Midnight `#071426`, Ion Cyan `#34D6F4`, Voltage Violet `#7C3AED`,
  Mango Fuse `#FF8A3D`, Signal Mint `#45E6A6`, Paper `#FBFCFE`, Ink `#101828`, Slate `#475467`.
- Dark-only UI; text contrast ≥4.5:1; visible focus rings; aria-labels on icon-only buttons;
  `prefers-reduced-motion` honored; no emoji icons (inline SVG only); local font stacks, no CDN.
- No network deps at runtime except the localhost bridge. TDD for core modules; commit per task.

---

### Task 1: Scaffold + design tokens + app shell
**Files:** `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`,
`src/App.tsx`, `src/styles/tokens.css`, `src/styles/base.css`, `src/components/AppShell.tsx`,
`src/components/icons.tsx`, `.gitignore`.
**Produces:** running `npm run dev|build|test`; `AppShell` with header (logo, view tabs Recipe/Graph/Shelf/Gallery, run controls slot) and panel layout.
**Verify:** `npm run build` passes. Commit `feat: scaffold branded app shell`.

### Task 2: Core types + capsule registry (TDD)
**Files:** `src/core/types.ts`, `src/core/capsules.ts`, `tests/capsules.test.ts`.
**Produces (exact):**
- `type SocketType = 'conditioning'|'model'|'lora_stack'|'control'|'latent'|'image'|'manifest'`
- `type CapsuleKind = 'prompt'|'model'|'loraRack'|'control'|'sampler'|'canvas'|'queue'|'export'|'manifest'`
- `interface SocketDef { id: string; label: string; type: SocketType }`
- `interface ParamDef { id: string; label: string; kind: 'text'|'textarea'|'number'|'select'|'seed'|'toggle'; min?: number; max?: number; step?: number; options?: {value:string;label:string}[]; default: unknown }`
- `interface CapsuleDef { kind: CapsuleKind; title: string; accent: string; description: string; inputs: SocketDef[]; outputs: SocketDef[]; params: ParamDef[] }`
- `CAPSULES: Record<CapsuleKind, CapsuleDef>` (all nine).
- `interface WorkflowNode { id: string; kind: CapsuleKind; x: number; y: number; params: Record<string, unknown> }`
- `interface WorkflowEdge { id: string; from: {node:string; socket:string}; to: {node:string; socket:string} }`
- `interface Workflow { id: string; name: string; version: number; schemaVersion: 1; nodes: WorkflowNode[]; edges: WorkflowEdge[] }`
**Tests:** registry has 9 kinds; every param has default; socket ids unique per node def.
Commit `feat: capsule registry and workflow schema`.

### Task 3: Workflow ops + default workflow (TDD)
**Files:** `src/core/workflow.ts`, `tests/workflow.test.ts`.
**Produces (exact):** `createNode(kind, x, y): WorkflowNode`, `createDefaultWorkflow(): Workflow`
(all 9 capsules pre-wired), `addNode/removeNode/updateNodeParam/moveNode/connect/disconnect`
(all `(wf, ...) => Workflow`, immutably bumping `version`), `canConnect(wf, from, to): {ok:boolean; reason?:string}`
(type match + no self-loop + single edge per input socket + cycle rejection).
Commit `feat: workflow operations`.

### Task 4: Model shelf data + compatibility (TDD)
**Files:** `src/core/shelf.ts`, `src/data/demoShelf.ts`, `tests/shelf.test.ts`.
**Produces (exact):**
- `interface ModelAsset { id: string; assetType: 'checkpoint'|'lora'; name: string; family: 'SD1.5'|'SDXL'|'SD3'|'Flux'; path: string; hash: string; sizeMB: number; tags: string[]; compatibility: string; license: string; installed: boolean }`
- `loraCompatible(lora, checkpoint): {ok:boolean; warning?:string}` (family match; cross-family → warning)
- `findAsset(shelf, id)`; demo shelf: 4 checkpoints + 6 LoRAs across families, one `installed:false`.
Commit `feat: model shelf data model + compatibility rules`.

### Task 5: Graph health checker (TDD)
**Files:** `src/core/health.ts`, `tests/health.test.ts`.
**Produces (exact):** `interface HealthIssue { id: string; severity: 'error'|'warning'; code: 'missing-model'|'model-not-installed'|'broken-link'|'socket-mismatch'|'bad-dimensions'|'vram-risk'|'lora-compat'|'disconnected'; message: string; nodeId?: string }`,
`checkHealth(wf: Workflow, shelf: ModelAsset[]): HealthIssue[]` — model param references missing/uninstalled asset; edges pointing at nonexistent nodes/sockets; type-mismatched edges; canvas dims (not multiple of 8, <256, >4096); VRAM estimate `estimateVramGB(width,height,batch,family)` vs 8 GB budget; LoRA/checkpoint family conflicts; sampler with no model input.
Commit `feat: graph health checker`.

### Task 6: Manifest builder (TDD)
**Files:** `src/core/manifest.ts`, `tests/manifest.test.ts`.
**Produces (exact):** `interface ExportManifest { app: 'LumenDeck'; appVersion: string; createdAt: string; prompt: string; negativePrompt: string; seed: number; sampler: {name:string; steps:number; cfg:number}; canvas: {width:number; height:number}; model: {id:string; name:string; family:string; hash:string}|null; loras: {id:string; name:string; weight:number; hash:string}[]; graphVersion: number; graph: Workflow }`,
`buildManifest(wf, shelf, appVersion, now: Date): ExportManifest` (pure; caller supplies time).
Commit `feat: export manifest builder`.

### Task 7: Backend adapters (TDD for job assembly)
**Files:** `src/bridge/adapter.ts`, `src/bridge/mockAdapter.ts`, `src/bridge/httpAdapter.ts`, `tests/job.test.ts`.
**Produces (exact):**
- `interface RenderJob { prompt: string; negativePrompt: string; seed: number; steps: number; cfg: number; width: number; height: number; modelId: string|null; loras: {id:string; weight:number}[]; sampler: string }`
- `buildRenderJob(wf: Workflow): RenderJob` (pure, tested)
- `interface BackendAdapter { id: string; label: string; ping(): Promise<boolean>; generate(job: RenderJob, onProgress?: (p:number)=>void): Promise<{dataUrl: string; seed: number}> }`
- `MockAdapter` (seeded PRNG → canvas gradient/starburst PNG data URL), `HttpAdapter` (POST `${base}/generate`, GET `/health`, GET `/models`).
Commit `feat: backend adapter interface + mock and http adapters`.

### Task 8: Zustand store + persistence
**Files:** `src/state/store.ts`, `src/state/persistence.ts`, `tests/store.test.ts`.
**Produces (exact):** `useStudio` store: `{ workflow, shelf, selectedNodeId, view, rackPresets, gallery, queue, health, adapterId, bridgeOnline }` + actions
`selectNode/setView/updateParam/moveNode/connectSockets/disconnectEdge/addCapsule/removeNode/`
`saveRackPreset(name)/applyRackPreset(id)/deleteRackPreset(id)/enqueueRender()/exportManifest()/refreshShelfFromBridge()`.
`GalleryItem { id; dataUrl; createdAt; manifest: ExportManifest }`. Persist workflow/presets/gallery to
localStorage key `lumendeck.v1` (guarded parse). Health recomputed via subscription.
**Test:** updateParam via store is visible in both a recipe projection and graph projection (same object identity).
Commit `feat: studio store with persistence`.

### Task 9: Recipe View + Inspector
**Files:** `src/components/recipe/RecipeView.tsx`, `src/components/recipe/RecipeCard.tsx`,
`src/components/inspector/Inspector.tsx`, `src/components/inspector/ParamField.tsx`.
Recipe = ordered cards (Prompt → Model → LoRA Rack → Control → Canvas → Sampler → Export) each editing
`workflow.nodes` params via the same `updateParam`; Inspector renders `ParamField` per `ParamDef`
(labels bound with `htmlFor`, helper text, number clamps, seed dice button with aria-label).
Commit `feat: recipe view + inspector`.

### Task 10: Graph View (custom SVG editor)
**Files:** `src/components/graph/GraphView.tsx`, `src/components/graph/GraphNode.tsx`,
`src/components/graph/wires.ts`.
Pan (drag bg) + zoom (wheel, 0.4–2), node drag (pointer capture, 4px threshold), edge create by
dragging from output port to input port (uses `canConnect`, invalid target shows danger tint),
edge delete (click + Delete key), node select → Inspector panel, add-capsule palette, minimap-free.
Ports colored by socket type + `title` tooltip; nodes are `role="group"` with `aria-label`, selectable
via keyboard (Tab + arrows move node 8px, Delete removes).
Commit `feat: editable svg node graph`.

### Task 11: Model Shelf + LoRA Rack UI
**Files:** `src/components/shelf/ModelShelf.tsx`, `src/components/rack/LoraRack.tsx`.
Shelf: filterable grid (All/Checkpoints/LoRAs + family filter), cards show name, family chip, size,
mono hash, path, tags, license, compatibility note, installed state; "Use" sets model param / adds to rack.
Rack (card in Recipe + inspector for loraRack node): rows with weight slider `-1..2 step 0.05`, remove,
add-from-shelf, per-row compat warning vs selected checkpoint, preset save/apply/delete.
Commit `feat: model shelf + lora rack`.

### Task 12: Queue, render flow, Gallery, export
**Files:** `src/components/queue/QueuePanel.tsx`, `src/components/gallery/Gallery.tsx`, `src/bridge/exporter.ts`.
Run button (blocked with reason when health has errors) → adapter generate with progress → GalleryItem.
Gallery grid → detail drawer: image, prompt, seed (mono), model+LoRA chips, timestamp, graph snapshot
(restore button loads snapshot as current workflow), Download PNG + Download manifest JSON
(`exporter.downloadJson/downloadDataUrl`).
Commit `feat: queue, gallery, manifest export`.

### Task 13: Python FastAPI bridge
**Files:** `bridge/main.py`, `bridge/renderer.py`, `bridge/scanner.py`, `bridge/adapters.py`,
`bridge/requirements.txt`, `bridge/README.md`, `bridge/test_renderer.py`.
`/health` → `{status:'ok', adapter:'procedural'}`; `/models` → scanner output (env `LUMENDECK_MODEL_DIR`,
falls back to demo catalog with real file hashing when dir exists); `/generate` → seeded procedural
PNG (pure stdlib zlib/struct, no Pillow) honoring width/height/seed/prompt-derived palette; CORS for
Vite origins. `adapters.py` defines `GeneratorAdapter` ABC + `ProceduralAdapter` + documented
`A1111Adapter` stub. Test renderer determinism via pytest if present else `python -m bridge.test_renderer`.
Commit `feat: fastapi render bridge`.

### Task 14: Polish, a11y pass, docs, release
**Files:** `README.md`, `RELEASE_NOTES.md`, `src/styles/*` tweaks.
Focus-visible audit, contrast audit (Slate on Midnight for secondary only ≥4.5 where body), reduced
motion media query, responsive check (≥768px side panels collapse to tabs). Run `npm test`,
`npm run build`, `tsc --noEmit`. Write run instructions + acceptance-criteria table.
Commit `docs: readme + release notes` and final report.

## Self-review
- Spec coverage: 9 capsules (T2), synced views (T8–T10), shelf (T4/T11), rack ≥2 LoRAs + presets (T11),
  adapters (T7/T13), gallery+manifest (T6/T12), health incl. all mandated warning classes (T5), a11y (T1/T14). ✓
- Types consistent across tasks (Workflow/ModelAsset/RenderJob/ExportManifest reused verbatim). ✓
- No placeholders; interface blocks are exact signatures. ✓
