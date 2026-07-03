# LumenDeck — Design Spec (2026-07-02)

A local-first, node-native generative image studio: the spiritual successor to Disco Diffusion.
Two synchronized editors — a beginner-friendly **Recipe View** (workflow cards) and an expert
**Graph View** (editable node graph) — operate on the **same workflow object**.

> Process note: built with the Superpowers workflow (brainstorming → spec → plan → implement →
> review) and UI/UX Pro Max for the design system. The user supplied a complete spec, brand,
> phases, and acceptance criteria and requested an autonomous build, so the brainstorming
> approval gates were satisfied by the provided requirements rather than interactive Q&A.

## Goals

- One `Workflow` document (nodes + edges + params + version) rendered two ways.
- Nine Capsule node types: Prompt, Model, LoRA Rack, Control, Sampler, Canvas, Queue, Export, Manifest.
- Model Shelf: local model/LoRA catalog with metadata, hash, path, tags, family, compatibility notes, license.
- LoRA Rack: stack ≥2 LoRAs with independent weights, save/load presets, compatibility warnings.
- Render Bridge: `BackendAdapter` interface with (a) in-browser mock adapter and (b) local Python/FastAPI bridge serving a deterministic text-to-image path plus a model scanner.
- Gallery: renders with prompt, seed, model, LoRA stack, timestamp, graph snapshot; export manifest JSON.
- Graph Health: pre-run warnings — missing models, broken links, incompatible sockets, bad dimensions, likely VRAM issues.

## Non-goals (YAGNI)

- No real diffusion inference bundled (adapter interface + mock path instead; A1111/ComfyUI adapters are stubs documented for later).
- No multi-workflow tabs, no collaboration, no cloud sync.
- No Electron/Tauri packaging in v0.1 (web app + local bridge; packaging noted in release notes).

## Approaches considered

1. **Custom SVG node editor + Zustand (chosen).** Zero graph dependencies, exact brand/node-card UX,
   graph is a pure projection of the workflow object, easy to test. Cost: hand-rolled drag/pan/connect.
2. React Flow (@xyflow/react): faster to stand up, but adds a large dep, its own state model to
   reconcile against the single workflow object, and CSS overrides to match brand.
3. Electron desktop app: heavier scaffold; local-first is already satisfied by localStorage + local bridge.

## Architecture

```
lumendeck/
  src/
    core/        pure TS, no React: types, capsule registry, workflow ops,
                 health checker, manifest builder, compatibility rules
    state/       Zustand store (single Workflow + shelf + presets + gallery + UI), localStorage persistence
    bridge/      BackendAdapter interface, MockAdapter (canvas PNG), HttpAdapter (FastAPI client)
    components/  AppShell, RecipeView, GraphView, Inspector, ModelShelf, LoraRack,
                 Gallery, HealthPanel, QueuePanel
    styles/      tokens.css (brand design tokens), base.css
  bridge/        Python FastAPI: /health /models /generate; adapter classes; pure-stdlib PNG renderer
  tests/         Vitest: workflow, capsules, health, manifest, rack/compat, store sync
  docs/superpowers/{specs,plans}/
```

**Data flow:** UI events → store actions → new `Workflow` (immutable updates) → both views re-render.
Recipe cards are groupings of the same node params the Graph inspector edits. Render: store gathers a
`RenderJob` from the workflow → active `BackendAdapter.generate()` → result saved to Gallery with a
frozen graph snapshot + manifest.

**Sockets:** typed (`conditioning`, `model`, `lora_stack`, `control`, `latent`, `image`, `manifest`).
Health checker validates edge type compatibility; the graph editor also refuses invalid connections at
connect time but health reports any that exist in loaded documents.

**Error handling:** adapter failures surface in the Queue panel per-job with message + retry; bridge
offline → app falls back to Mock adapter with a visible banner; malformed persisted state → versioned
migration or reset-to-default with console warning.

## Design system (UI/UX Pro Max)

- Style: OLED dark only; Midnight `#071426` background; Paper `#FBFCFE` text; Slate for secondary.
- Semantic tokens: `--ld-bg, --ld-surface, --ld-surface-2, --ld-text, --ld-text-dim, --ld-accent (Ion Cyan),
  --ld-accent-2 (Voltage Violet), --ld-warn (Mango Fuse), --ld-ok (Signal Mint), --ld-danger`, focus ring tokens.
- Capsule color coding: each capsule family gets an accent (Prompt=cyan, Model=violet, LoRA=mint,
  Control=mango, Sampler=cyan, Canvas=violet, Queue=mango, Export=mint, Manifest=slate) — always paired
  with a text label and SVG icon, never color alone.
- Type: Inter (local stack, system-ui fallback) for UI; JetBrains Mono stack for seeds/hashes/prompts.
- Accessibility: 4.5:1 text contrast, visible 2px focus rings, aria labels on icon buttons, keyboard
  operable views, `prefers-reduced-motion` respected, 150–300ms transitions.

## Testing

Vitest on the pure core: capsule registry integrity, workflow ops (add/remove/connect), recipe↔graph
same-object invariant, health checker (each warning class), manifest content, LoRA rack presets +
compatibility. `tsc --noEmit` for types; `vite build` for the bundle. Python bridge: `pytest` smoke test
for PNG generation if pytest available (documented otherwise).

## Acceptance criteria

As given by the product requirements (Recipe/Graph same object; editable capsules via inspector; shelf
metadata; rack ≥2 LoRAs + presets; health warnings incl. missing model/broken link/bad dims/compat;
adapter interface; gallery fields; manifest fields incl. app version; a11y; honest test/build reporting).
