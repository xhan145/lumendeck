# Constellation Gravity Fabric v0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "First Implementation Slice" from the constellation GPU-overhaul redteam spec — a stateless, data-driven gravity-fabric layer under the 3D node graph (mass → gaussian well depth + contour lines), behind a flag, with pure frame instrumentation and a seeded encoding registry — committing to nothing else in the overhaul.

**Architecture:** Two new pure modules (`graph3d/frameStats.ts` instrument, `graph3d/fabric.ts` effect) plus a 20-line `graph3d/encodings.ts` registry seed and one optional `AppSettings` flag. The fabric mounts as its **own** `THREE.Group` beside the existing GridHelpers (the codebase's documented overlay contract — "added/removed alongside, not within"), displaces its vertices analytically from ≤64 well uniforms (a pure function of graph state, mirrored on the CPU for tests), and **adds no animation loop**: it repacks only inside the existing orb-reconcile effect and redraws via the existing `requestRender()`. Flag off ⇒ the module is never constructed ⇒ the scene is identical to today.

**Tech Stack:** React 18.3.1 · TypeScript ~5.7.2 · Zustand 5.0.3 · Three.js ^0.185.1 (raw `WebGLRenderer` + `CSS3DRenderer`, no react-three-fiber) · Vite 6 · Vitest 3 (node environment). Windows Tauri v2 / WebView2 (Chromium, ANGLE→D3D11, WebGL2).

## Global Constraints

Every task's requirements implicitly include these (values copied verbatim from `docs/superpowers/specs/2026-07-07-constellation-gpu-overhaul-redteam-design.md`):

- **Flag enum is FINAL from day one:** `graph3dEffects?: 'off' | 'minimal' | 'standard' | 'rich'` on `AppSettings`, optional-additive (older persisted blobs must still load), sanitize accepts exactly those four literals else `undefined`; **unset is treated as `'off'` component-side**. Default off. This avoids any settings migration in later phases.
- **No new animation loop in this slice.** The fabric changes only when the graph does, so the dirty-flag scheduler already covers it. No rAF, no timer, no settle clock (that arrives with ripples in Phase 2).
- **Fabric material compositing (non-negotiable, over a transparent `alpha:true` canvas):** `fog: false` (custom ShaderMaterials don't inherit fog, and `THREE.Fog` lerps RGB toward opaque `#071426` without touching alpha → a fog-faded plane becomes an opaque slab over the DOM), `depthWrite: false`, `renderOrder: -1` (draw beneath the additive grid/wire/ring pass so it never stomps their transparency sort), straight-alpha radial distance fade to 0 (renderer `premultipliedAlpha` is false → do NOT premultiply).
- **Wells:** `MAX_WELLS = 64`; weightless nodes (null `weightT`) create **no** well (flat fabric is the honest rendering); more than 64 weighted nodes ⇒ keep the 64 deepest and emit exactly one `console.warn` (all tiers).
- **Uniforms, not textures.** No new render targets, no `readPixels`, ever. Picking stays CPU raycast (the fabric group is never added to any raycast group).
- **Flag off = byte-identical:** with `graph3dEffects` unset/`'off'`, zero new code runs in the render path and the scene renders identically to v0.19.1.
- **Brand tokens:** fabric shallow = Ion Cyan `--ld-cyan` (#34D6F4), deep = Voltage Violet `--ld-violet` (#7C3AED); resolve via `resolveCssColor` before handing to THREE.
- **No new heavy dependencies.** Three.js is already a dependency; add nothing.
- **Standing gates (run every task, hard-fail otherwise):** full vitest suite green, `npx tsc --noEmit` clean. Do not bloat the sidecar/MSI (no bridge changes here). Commit per task.
- **Pure-module convention:** `graph3d/*.ts` helpers are pure (no DOM) or three-only, kept out of the 1716-line `Graph3DView.tsx`, and unit-tested — mirror `orbWeight.ts` / `projection.ts` / `scene.ts`.

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `src/state/appSettings.ts` | Modify | Add the optional `graph3dEffects` flag + sanitize clause + `Graph3DEffects` type. Zero render risk. Persisted automatically (appSettings is already in the persisted projection). |
| `src/components/graph/graph3d/frameStats.ts` | Create | Pure frame-time EMA + worst-frame window + draw-call snapshot. No DOM, no three. |
| `src/components/graph/graph3d/encodings.ts` | Create | Data→visual encoding registry, seeded with the single `mass → fabric well` entry + a validator. Pure. |
| `src/components/graph/graph3d/fabric.ts` | Create | Gravity fabric: `packWells` + `fabricDisplacement` (pure CPU mirror) and `createFabric` (THREE builder with GLSL, compositing per Global Constraints). |
| `src/components/graph/Graph3DView.tsx` | Modify | Wire it in: frameStats taps at the 4 render sites, diagnostics overlay, fabric lifecycle effect, well-refresh in the orb-reconcile effect, toolbar toggle. Touched last, minimally (≤120 lines). |
| `src/styles/graph3d.css` | Modify | One rule for the diagnostics overlay chip. |
| `tests/frameStats.test.ts` | Create | frameStats aggregation + reset. |
| `tests/fabric.test.ts` | Create | `packWells`, `fabricDisplacement`, `createFabric` smoke, encodings registry, appSettings `graph3dEffects` sanitize. |

Dependency order: appSettings (Task 1) → frameStats (Task 2) → encodings (Task 3) → fabric pure (Task 4) → fabric builder (Task 5) → Graph3DView frameStats wiring (Task 6) → Graph3DView fabric wiring + toggle (Task 7) → CSS (Task 8) → manual verify + measured claim (Task 9) → final gate + finish (Task 10).

---

### Task 1: `graph3dEffects` flag on AppSettings

**Files:**
- Modify: `src/state/appSettings.ts` (interface ~line 51, defaults leave unset, sanitize ~line 105)
- Test: `tests/fabric.test.ts` (create; sanitize section)

**Interfaces:**
- Produces: `type Graph3DEffects = 'off' | 'minimal' | 'standard' | 'rich'`; `AppSettings.graph3dEffects?: Graph3DEffects`; `sanitizeAppSettings` maps invalid values → `undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/fabric.test.ts` with this first block (import path matches the existing `tests/*` convention — sibling tests import from `../src/...`):

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeAppSettings } from '../src/state/appSettings';

describe('appSettings graph3dEffects', () => {
  it('accepts the four valid effect levels', () => {
    for (const v of ['off', 'minimal', 'standard', 'rich'] as const) {
      expect(sanitizeAppSettings({ graph3dEffects: v }).graph3dEffects).toBe(v);
    }
  });

  it('drops invalid or missing values to undefined (older blobs still load)', () => {
    expect(sanitizeAppSettings({ graph3dEffects: 'ultra' as never }).graph3dEffects).toBeUndefined();
    expect(sanitizeAppSettings({}).graph3dEffects).toBeUndefined();
    expect(sanitizeAppSettings(undefined).graph3dEffects).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts`
Expected: FAIL — `graph3dEffects` is `undefined` for the valid-values case (property not yet sanitized/typed).

- [ ] **Step 3: Add the type + interface field**

In `src/state/appSettings.ts`, after `export type Graph3DStyle = 'orbs' | 'cards';` (line 9) add:

```ts
export type Graph3DEffects = 'off' | 'minimal' | 'standard' | 'rich';
```

In the `AppSettings` interface, immediately after the `graph3dStyle?: Graph3DStyle;` field (line 51), add:

```ts
  /**
   * Constellation GPU-overhaul effects level (First Slice: gravity fabric only).
   * Optional and additive: state persisted before the overhaul still loads; when
   * unset, the 3D view treats it as 'off'. The enum is FINAL — later phases add
   * behavior behind the same four levels without a settings migration.
   */
  graph3dEffects?: Graph3DEffects;
```

- [ ] **Step 4: Add the sanitize clause**

In `sanitizeAppSettings`, immediately after the `graph3dStyle:` line (line 105), add:

```ts
    graph3dEffects:
      settings?.graph3dEffects === 'off' ||
      settings?.graph3dEffects === 'minimal' ||
      settings?.graph3dEffects === 'standard' ||
      settings?.graph3dEffects === 'rich'
        ? settings.graph3dEffects
        : undefined,
```

- [ ] **Step 5: Run the test + typecheck**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts && npx tsc --noEmit`
Expected: PASS (3 assertions) and no type errors.

- [ ] **Step 6: Commit**

```bash
cd ~/lumendeck && git add src/state/appSettings.ts tests/fabric.test.ts && git commit -m "feat(fabric): add graph3dEffects flag to AppSettings (final enum, sanitized)"
```

---

### Task 2: `frameStats.ts` — pure frame instrumentation

**Files:**
- Create: `src/components/graph/graph3d/frameStats.ts`
- Test: `tests/frameStats.test.ts`

**Interfaces:**
- Produces: `interface FrameStats { frameMs; fps; worstMs; drawCalls; samples }`; `interface FrameStatsAccumulator { sample(dtMs); setDrawCalls(calls); read(): FrameStats; reset() }`; `createFrameStats(opts?: { emaAlpha?; windowSize? }): FrameStatsAccumulator`.

- [ ] **Step 1: Write the failing test**

Create `tests/frameStats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createFrameStats } from '../src/components/graph/graph3d/frameStats';

describe('createFrameStats', () => {
  it('averages a steady frame time to the matching fps', () => {
    const fs = createFrameStats();
    for (let i = 0; i < 300; i++) fs.sample(16.67);
    const s = fs.read();
    expect(s.frameMs).toBeCloseTo(16.67, 1);
    expect(s.fps).toBeCloseTo(60, 0);
    expect(s.samples).toBe(300);
  });

  it('tracks the worst frame over the window and ignores it in the EMA', () => {
    const fs = createFrameStats({ windowSize: 10 });
    for (let i = 0; i < 5; i++) fs.sample(10);
    fs.sample(120); // one spike
    for (let i = 0; i < 4; i++) fs.sample(10);
    expect(fs.read().worstMs).toBe(120);
    expect(fs.read().frameMs).toBeLessThan(60); // EMA not dominated by the spike
  });

  it('rolls the worst-frame window (old spikes age out)', () => {
    const fs = createFrameStats({ windowSize: 3 });
    fs.sample(100);
    fs.sample(10); fs.sample(10); fs.sample(10);
    expect(fs.read().worstMs).toBe(10); // the 100ms spike has left the window
  });

  it('records draw calls and rejects garbage samples', () => {
    const fs = createFrameStats();
    fs.sample(16);
    fs.sample(-5);        // ignored
    fs.sample(NaN);       // ignored
    fs.setDrawCalls(173);
    fs.setDrawCalls(-1);  // ignored
    const s = fs.read();
    expect(s.samples).toBe(1);
    expect(s.drawCalls).toBe(173);
  });

  it('reset clears everything', () => {
    const fs = createFrameStats();
    fs.sample(16); fs.setDrawCalls(50);
    fs.reset();
    const s = fs.read();
    expect(s.samples).toBe(0);
    expect(s.frameMs).toBe(0);
    expect(s.drawCalls).toBe(0);
    expect(s.worstMs).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/lumendeck && npx vitest run tests/frameStats.test.ts`
Expected: FAIL — module not found (`frameStats` not created).

- [ ] **Step 3: Create the module**

Create `src/components/graph/graph3d/frameStats.ts`:

```ts
/**
 * Pure frame-time instrumentation for the 3D graph. No DOM, no three.js — the
 * caller feeds per-render deltas and the renderer's draw-call count; this module
 * only aggregates. Fully unit-testable (tests/frameStats.test.ts).
 *
 * Phase 0 of the constellation GPU overhaul: "instrumentation before effect."
 */

export interface FrameStats {
  /** Exponential-moving-average frame time in milliseconds. */
  frameMs: number;
  /** EMA-derived frames per second (1000 / frameMs). */
  fps: number;
  /** Worst (max) frame time over the recent sample window, milliseconds. */
  worstMs: number;
  /** Most recent draw-call count (renderer.info.render.calls), 0 if unset. */
  drawCalls: number;
  /** Frames sampled since the last reset. */
  samples: number;
}

export interface FrameStatsAccumulator {
  /** Record one rendered frame's duration (ms since the previous render). */
  sample(dtMs: number): void;
  /** Record the current draw-call count (renderer.info.render.calls). */
  setDrawCalls(calls: number): void;
  /** Current aggregated stats (cheap; safe to call every publish tick). */
  read(): FrameStats;
  /** Clear all history (e.g. on view remount). */
  reset(): void;
}

const DEFAULT_ALPHA = 0.1; // EMA smoothing (higher = snappier)
const DEFAULT_WINDOW = 120; // worst-frame window (~2s at 60fps)

function clampAlpha(a: number): number {
  if (!Number.isFinite(a)) return DEFAULT_ALPHA;
  return Math.min(1, Math.max(0.001, a));
}

export function createFrameStats(opts?: { emaAlpha?: number; windowSize?: number }): FrameStatsAccumulator {
  const alpha = clampAlpha(opts?.emaAlpha ?? DEFAULT_ALPHA);
  const windowSize = Math.max(1, Math.floor(opts?.windowSize ?? DEFAULT_WINDOW));
  const ring = new Float64Array(windowSize);
  let ringLen = 0;
  let ringHead = 0;
  let frameMs = 0;
  let drawCalls = 0;
  let samples = 0;

  return {
    sample(dtMs: number) {
      if (!Number.isFinite(dtMs) || dtMs < 0) return;
      frameMs = samples === 0 ? dtMs : alpha * dtMs + (1 - alpha) * frameMs;
      ring[ringHead] = dtMs;
      ringHead = (ringHead + 1) % windowSize;
      if (ringLen < windowSize) ringLen++;
      samples++;
    },
    setDrawCalls(calls: number) {
      if (Number.isFinite(calls) && calls >= 0) drawCalls = calls;
    },
    read(): FrameStats {
      let worst = 0;
      for (let i = 0; i < ringLen; i++) if (ring[i] > worst) worst = ring[i];
      return { frameMs, fps: frameMs > 0 ? 1000 / frameMs : 0, worstMs: worst, drawCalls, samples };
    },
    reset() {
      ringLen = 0;
      ringHead = 0;
      frameMs = 0;
      drawCalls = 0;
      samples = 0;
    },
  };
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd ~/lumendeck && npx vitest run tests/frameStats.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
cd ~/lumendeck && git add src/components/graph/graph3d/frameStats.ts tests/frameStats.test.ts && git commit -m "feat(fabric): pure frameStats instrument (EMA + worst-window + draw calls)"
```

---

### Task 3: `encodings.ts` — seed the data→visual registry

**Files:**
- Create: `src/components/graph/graph3d/encodings.ts`
- Test: `tests/fabric.test.ts` (append an encodings block)

**Interfaces:**
- Produces: `type EncodingLayer = 'fabric'`; `interface EncodingEntry { id; datum; channel; layer; alwaysOn }`; `const ENCODINGS: readonly EncodingEntry[]`; `registeredLayers(): Set<EncodingLayer>`; `unregisteredLayers(active: readonly EncodingLayer[]): EncodingLayer[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/fabric.test.ts`:

```ts
import { ENCODINGS, unregisteredLayers } from '../src/components/graph/graph3d/fabric-encodings-barrel';
```

Wait — do NOT add that import. Instead append this block to `tests/fabric.test.ts` importing directly from `encodings`:

```ts
import { ENCODINGS, unregisteredLayers, registeredLayers } from '../src/components/graph/graph3d/encodings';

describe('encoding registry (hard rule: no layer without a datum)', () => {
  it('seeds exactly the mass→fabric-well encoding', () => {
    expect(ENCODINGS).toHaveLength(1);
    const mass = ENCODINGS[0];
    expect(mass.id).toBe('mass');
    expect(mass.layer).toBe('fabric');
    expect(mass.datum).toContain('weightT');
    expect(mass.alwaysOn).toBe(true);
  });

  it('passes when every active layer is registered', () => {
    expect(unregisteredLayers(['fabric'])).toEqual([]);
    expect(registeredLayers().has('fabric')).toBe(true);
  });

  it('flags an active layer with no registry entry', () => {
    // @ts-expect-error deliberately unregistered layer name
    expect(unregisteredLayers(['fabric', 'ripples'])).toEqual(['ripples']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts`
Expected: FAIL — `encodings` module not found.

- [ ] **Step 3: Create the module**

Create `src/components/graph/graph3d/encodings.ts`:

```ts
/**
 * Data→visual encoding registry for the 3D constellation. PURE, unit-tested.
 *
 * Hard rule (redteam spec, "Data Encoding Rules"): no visual layer may render
 * without a registry entry naming the exact product datum it encodes. SEEDED in
 * the First Slice with the single mass→fabric-well entry and grown in later
 * phases. A unit test walks the active layer list against this registry so an
 * unregistered effect fails CI.
 */

/** A rendered visual layer that must justify itself with a data source. */
export type EncodingLayer = 'fabric';

export interface EncodingEntry {
  /** Stable id (also the human-facing name in the legend). */
  id: string;
  /** Exact product datum this encoding reads, as an auditable string. */
  datum: string;
  /** The visual channel it drives. */
  channel: string;
  /** The render layer that owns the channel. */
  layer: EncodingLayer;
  /** Always on (vs behind a toggle/tooltip). */
  alwaysOn: boolean;
}

/** The registry. Every shipped visual layer MUST appear here. */
export const ENCODINGS: readonly EncodingEntry[] = [
  {
    id: 'mass',
    datum: 'weightT(primaryWeight(kind, params))',
    channel: 'fabric well depth + sigma',
    layer: 'fabric',
    alwaysOn: true,
  },
];

/** All layers named by at least one registry entry. */
export function registeredLayers(): Set<EncodingLayer> {
  return new Set(ENCODINGS.map((e) => e.layer));
}

/**
 * Active render layers with no backing registry entry (empty = compliant).
 * Tests assert this stays empty for the layers the view actually renders.
 */
export function unregisteredLayers(activeLayers: readonly EncodingLayer[]): EncodingLayer[] {
  const known = registeredLayers();
  return activeLayers.filter((l) => !known.has(l));
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts && npx tsc --noEmit`
Expected: PASS. (The `@ts-expect-error` line must be honored — `'ripples'` is not an `EncodingLayer`. If tsc complains the directive is unused, the type is too loose; keep `EncodingLayer = 'fabric'` narrow.)

- [ ] **Step 5: Commit**

```bash
cd ~/lumendeck && git add src/components/graph/graph3d/encodings.ts tests/fabric.test.ts && git commit -m "feat(fabric): seed data->visual encoding registry (mass->fabric well)"
```

---

### Task 4: `fabric.ts` — pure well math (CPU mirror)

**Files:**
- Create: `src/components/graph/graph3d/fabric.ts` (pure exports first; the THREE builder lands in Task 5)
- Test: `tests/fabric.test.ts` (append a packWells + displacement block)

**Interfaces:**
- Consumes: `weightT(kind, params)` from `./orbWeight`; `orbWorldCenter(node)` from `./projection`; `GRID_Y` from `./scene`; `WorkflowNode` from `../../../core/types`.
- Produces: `const MAX_WELLS = 64`; `interface Well { x; z; depth; sigma }`; `packWells(nodes): { wells: Well[]; clamped: boolean }`; `fabricDisplacement(x, z, wells): number`; `const FABRIC_SEGMENTS = { minimal: 64, standard: 128, rich: 192 }`; `type FabricTier = keyof typeof FABRIC_SEGMENTS`.

- [ ] **Step 1: Write the failing test**

Append to `tests/fabric.test.ts`:

```ts
import { packWells, fabricDisplacement, MAX_WELLS } from '../src/components/graph/graph3d/fabric';
import type { WorkflowNode } from '../src/core/types';

function sampler(id: string, cfg: number): WorkflowNode {
  return { id, kind: 'sampler', x: 0, y: 0, params: { cfg } };
}

describe('packWells', () => {
  it('creates one well per weighted node, none for weightless kinds', () => {
    const nodes: WorkflowNode[] = [
      sampler('s1', 15),
      { id: 'note', kind: 'prompt', x: 200, y: 0, params: {} }, // no numeric weight
    ];
    const { wells, clamped } = packWells(nodes);
    expect(clamped).toBe(false);
    expect(wells).toHaveLength(1); // prompt is weightless → no well
    expect(wells[0].depth).toBeGreaterThan(0);
    expect(wells[0].sigma).toBeGreaterThan(0);
  });

  it('scales depth + sigma with normalized weight (heavier = deeper + wider)', () => {
    const light = packWells([sampler('a', 3)]).wells[0];
    const heavy = packWells([sampler('b', 27)]).wells[0];
    expect(heavy.depth).toBeGreaterThan(light.depth);
    expect(heavy.sigma).toBeGreaterThan(light.sigma);
  });

  it('clamps to the 64 deepest wells and flags it beyond MAX_WELLS', () => {
    const nodes: WorkflowNode[] = [];
    for (let i = 0; i < MAX_WELLS + 10; i++) nodes.push(sampler(`n${i}`, 1 + (i % 30)));
    const { wells, clamped } = packWells(nodes);
    expect(clamped).toBe(true);
    expect(wells).toHaveLength(MAX_WELLS);
    // deepest kept: min kept depth >= max dropped depth
    const keptMin = Math.min(...wells.map((w) => w.depth));
    const allSorted = nodes.map((n) => packWells([n]).wells[0].depth).sort((p, q) => q - p);
    expect(keptMin).toBeGreaterThanOrEqual(allSorted[MAX_WELLS - 1] - 1e-9);
  });
});

describe('fabricDisplacement (CPU mirror of the vertex shader)', () => {
  it('is zero with no wells', () => {
    expect(fabricDisplacement(0, 0, [])).toBe(0);
  });

  it('peaks at the well center and decays with distance', () => {
    const wells = [{ x: 0, z: 0, depth: 100, sigma: 200 }];
    const atCenter = fabricDisplacement(0, 0, wells);
    const far = fabricDisplacement(1000, 0, wells);
    expect(atCenter).toBeCloseTo(100, 5);
    expect(far).toBeLessThan(1);
  });

  it('superposes multiple wells additively', () => {
    const a = { x: -100, z: 0, depth: 50, sigma: 150 };
    const b = { x: 100, z: 0, depth: 50, sigma: 150 };
    const mid = fabricDisplacement(0, 0, [a, b]);
    const single = fabricDisplacement(0, 0, [a]);
    expect(mid).toBeCloseTo(2 * single, 6);
  });

  it('a wider sigma spreads more displacement to a fixed off-center point', () => {
    const narrow = fabricDisplacement(150, 0, [{ x: 0, z: 0, depth: 100, sigma: 100 }]);
    const wide = fabricDisplacement(150, 0, [{ x: 0, z: 0, depth: 100, sigma: 300 }]);
    expect(wide).toBeGreaterThan(narrow);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts`
Expected: FAIL — `fabric` module not found.

- [ ] **Step 3: Create the pure core of the module**

Create `src/components/graph/graph3d/fabric.ts` with ONLY the pure parts for now (the THREE builder is Task 5):

```ts
import type { WorkflowNode } from '../../../core/types';
import { orbWorldCenter } from './projection';
import { weightT } from './orbWeight';

/**
 * Gravity-fabric layer for the 3D constellation: a horizontal plane at grid
 * height that dips into gaussian "wells" under each weighted node — depth AND
 * width encoding the node's normalized primary weight (mass). Contour lines read
 * the field. STATELESS: displacement is a pure function of the well uniforms, so
 * it is starvation-immune and mirrored on the CPU (fabricDisplacement) for tests.
 *
 * The THREE builder (createFabric) lives at the bottom; everything above is pure.
 */

/** Hard cap on simultaneous wells (uniform array length). */
export const MAX_WELLS = 64;

/** Max downward dip (world units) at weightT = 1. */
const DEPTH_SCALE = 150;
/** Gaussian sigma at weightT 0 → 1 (heavier mass = wider well). */
const SIGMA_MIN = 130;
const SIGMA_MAX = 340;

/** Vertex-shader plane densities per quality tier (mid = the slice default). */
export const FABRIC_SEGMENTS = { minimal: 64, standard: 128, rich: 192 } as const;
export type FabricTier = keyof typeof FABRIC_SEGMENTS;

/** One gravity well: world xz, dip depth (world units), gaussian sigma. */
export interface Well {
  x: number;
  z: number;
  depth: number;
  sigma: number;
}

/**
 * Derive wells from a node list. Weightless nodes (null weightT) produce NO well
 * (flat fabric is the honest rendering). If more than MAX_WELLS qualify, the
 * deepest MAX_WELLS are kept and `clamped` is true (caller warns once).
 */
export function packWells(nodes: readonly WorkflowNode[]): { wells: Well[]; clamped: boolean } {
  const all: Well[] = [];
  for (const node of nodes) {
    const t = weightT(node.kind, node.params);
    if (t == null) continue; // weightless kind → no well
    const c = orbWorldCenter(node);
    all.push({
      x: c.x,
      z: c.z,
      depth: t * DEPTH_SCALE,
      sigma: SIGMA_MIN + t * (SIGMA_MAX - SIGMA_MIN),
    });
  }
  if (all.length <= MAX_WELLS) return { wells: all, clamped: false };
  const kept = [...all].sort((a, b) => b.depth - a.depth).slice(0, MAX_WELLS);
  return { wells: kept, clamped: true };
}

/**
 * CPU mirror of the vertex-shader displacement: total downward dip (world units,
 * ≥0) at world (x, z) from the superposition of all wells. Exact same math the
 * GPU runs, so unit tests validate the visual field.
 */
export function fabricDisplacement(x: number, z: number, wells: readonly Well[]): number {
  let disp = 0;
  for (const w of wells) {
    const dx = x - w.x;
    const dz = z - w.z;
    const r2 = dx * dx + dz * dz;
    const sigma = Math.max(w.sigma, 1);
    disp += w.depth * Math.exp(-r2 / (2 * sigma * sigma));
  }
  return disp;
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts && npx tsc --noEmit`
Expected: PASS (all packWells + displacement tests), no type errors.

- [ ] **Step 5: Commit**

```bash
cd ~/lumendeck && git add src/components/graph/graph3d/fabric.ts tests/fabric.test.ts && git commit -m "feat(fabric): pure well packing + CPU displacement mirror"
```

---

### Task 5: `fabric.ts` — the THREE builder (`createFabric`)

**Files:**
- Modify: `src/components/graph/graph3d/fabric.ts` (append the builder + GLSL)
- Test: `tests/fabric.test.ts` (append a construction smoke block)

**Interfaces:**
- Consumes: `GRID_Y` from `./scene`; `three`.
- Produces: `interface FabricHandle { readonly group: THREE.Group; update(nodes): { clamped: boolean }; dispose(): void }`; `createFabric(tier: FabricTier, shallow: string, deep: string): FabricHandle`.

- [ ] **Step 1: Write the failing test**

Append to `tests/fabric.test.ts`. (Three.js constructs geometries/materials with plain typed arrays — no WebGL context needed — so this runs in the node env; only `renderer.render` would require a GL context, which we never call.)

```ts
import { createFabric } from '../src/components/graph/graph3d/fabric';

describe('createFabric (THREE builder — no GL context needed for construction)', () => {
  it('builds a fabric group whose material composites correctly over the transparent canvas', () => {
    const fabric = createFabric('standard', '#34D6F4', '#7C3AED');
    expect(fabric.group.children.length).toBe(1);
    const mesh = fabric.group.children[0] as import('three').Mesh;
    const mat = mesh.material as import('three').ShaderMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(false);
    expect(mesh.renderOrder).toBe(-1);
    expect(mat.uniforms.uWellCount.value).toBe(0);
    fabric.dispose();
  });

  it('update() uploads well count + positions and reports clamp state', () => {
    const fabric = createFabric('minimal', '#34D6F4', '#7C3AED');
    const nodes: WorkflowNode[] = [sampler('s1', 15), sampler('s2', 6)];
    const { clamped } = fabric.update(nodes);
    const mat = (fabric.group.children[0] as import('three').Mesh).material as import('three').ShaderMaterial;
    expect(clamped).toBe(false);
    expect(mat.uniforms.uWellCount.value).toBe(2);
    const wells = mat.uniforms.uWells.value as import('three').Vector4[];
    expect(wells[0].z).toBeGreaterThan(0); // depth packed into vec4.z
    fabric.dispose();
  });

  it('dispose() detaches the group and is idempotent', () => {
    const fabric = createFabric('minimal', '#34D6F4', '#7C3AED');
    expect(() => { fabric.dispose(); fabric.dispose(); }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts`
Expected: FAIL — `createFabric` not exported.

- [ ] **Step 3: Append the builder to `fabric.ts`**

At the TOP of `src/components/graph/graph3d/fabric.ts`, add the three import and GRID_Y import to the existing import block:

```ts
import * as THREE from 'three';
```
(place as the first import line), and add to the existing imports:
```ts
import { GRID_Y } from './scene';
```

Then append to the BOTTOM of `fabric.ts`:

```ts
// ---- THREE builder (three-only; construction needs no GL context) ----------

/** Plane extent (world units) — matches the main neon grid so it reads as ground. */
const FABRIC_SIZE = 4800;
/** World-radial distance over which the plane fades to alpha 0 (into the DOM bg). */
const FADE_START = 1500;
const FADE_END = 2300;
/** Displacement (world units) between equipotential contour lines. */
const CONTOUR_SPACING = 26;

const FABRIC_VERTEX_SHADER = /* glsl */ `
  uniform vec4 uWells[${MAX_WELLS}];   // xy = world xz, z = depth, w = sigma
  uniform int uWellCount;
  varying float vDisp;
  varying vec2 vWorldXZ;
  void main() {
    vec3 p = position;                 // plane laid flat: p.x, p.z are world xz
    float disp = 0.0;
    for (int i = 0; i < ${MAX_WELLS}; i++) {
      if (i >= uWellCount) break;
      vec4 w = uWells[i];
      float dx = p.x - w.x;
      float dz = p.z - w.y;
      float r2 = dx * dx + dz * dz;
      float sigma = max(w.w, 1.0);
      disp += w.z * exp(-r2 / (2.0 * sigma * sigma));
    }
    p.y -= disp;
    vDisp = disp;
    vWorldXZ = vec2(p.x, p.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FABRIC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uShallow;   // brand cyan — flat fabric
  uniform vec3 uDeep;      // brand violet — deep well
  uniform float uDepthScale;
  uniform float uContourSpacing;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  varying float vDisp;
  varying vec2 vWorldXZ;
  void main() {
    float d = clamp(vDisp / uDepthScale, 0.0, 1.0);
    vec3 col = mix(uShallow, uDeep, d);

    // Equipotential contour lines — luminance, not hue (colorblind-safe).
    float phase = vDisp / uContourSpacing;
    float aa = fwidth(phase);
    float line = 1.0 - smoothstep(0.0, aa * 1.5, abs(fract(phase - 0.5) - 0.5));
    col += line * 0.35;

    // Straight-alpha radial fade into the transparent DOM background.
    float radial = length(vWorldXZ);
    float alpha = (1.0 - smoothstep(uFadeStart, uFadeEnd, radial)) * 0.5;
    alpha += line * 0.25 * alpha;
    if (alpha <= 0.001) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface FabricHandle {
  /** The scene group to add beside the GridHelpers. */
  readonly group: THREE.Group;
  /** Repack wells from the current graph + upload uniforms. Returns clamp state. */
  update(nodes: readonly WorkflowNode[]): { clamped: boolean };
  /** Remove from parent + dispose geometry/material (idempotent). */
  dispose(): void;
}

/**
 * Build a fabric layer at the given tier density. `shallow`/`deep` are concrete
 * colors — resolve CSS vars (resolveCssColor) before calling. Compositing is
 * pinned per the redteam spec: fog:false, depthWrite:false, renderOrder:-1,
 * straight-alpha fade — correct over the alpha:true canvas, never stomps wires.
 */
export function createFabric(tier: FabricTier, shallow: string, deep: string): FabricHandle {
  const segments = FABRIC_SEGMENTS[tier];
  const geometry = new THREE.PlaneGeometry(FABRIC_SIZE, FABRIC_SIZE, segments, segments);
  geometry.rotateX(-Math.PI / 2); // XY plane → XZ ground plane (normal +y)

  const wellData: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_WELLS; i++) wellData.push(new THREE.Vector4(0, 0, 0, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: FABRIC_VERTEX_SHADER,
    fragmentShader: FABRIC_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: false,
    extensions: { derivatives: true } as THREE.ShaderMaterialParameters['extensions'],
    uniforms: {
      uWells: { value: wellData },
      uWellCount: { value: 0 },
      uShallow: { value: new THREE.Color(shallow) },
      uDeep: { value: new THREE.Color(deep) },
      uDepthScale: { value: DEPTH_SCALE },
      uContourSpacing: { value: CONTOUR_SPACING },
      uFadeStart: { value: FADE_START },
      uFadeEnd: { value: FADE_END },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = GRID_Y;
  mesh.renderOrder = -1;
  mesh.frustumCulled = false; // large plane; skip cull cost + edge popping

  const group = new THREE.Group();
  group.add(mesh);

  return {
    group,
    update(nodes) {
      const { wells, clamped } = packWells(nodes);
      const arr = material.uniforms.uWells.value as THREE.Vector4[];
      for (let i = 0; i < wells.length; i++) arr[i].set(wells[i].x, wells[i].z, wells[i].depth, wells[i].sigma);
      material.uniforms.uWellCount.value = wells.length;
      return { clamped };
    },
    dispose() {
      group.parent?.remove(group);
      geometry.dispose();
      material.dispose();
    },
  };
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `cd ~/lumendeck && npx vitest run tests/fabric.test.ts && npx tsc --noEmit`
Expected: PASS. If tsc rejects the `extensions` cast, replace the cast line with `extensions: { derivatives: true },` (three ≥0.185 types accept it) and re-run.

- [ ] **Step 5: Run the WHOLE suite (regression gate)**

Run: `cd ~/lumendeck && npx vitest run`
Expected: the full suite is green (existing count + the new frameStats/fabric tests). Zero failures.

- [ ] **Step 6: Commit**

```bash
cd ~/lumendeck && git add src/components/graph/graph3d/fabric.ts tests/fabric.test.ts && git commit -m "feat(fabric): createFabric THREE builder (gaussian wells + contour GLSL)"
```

---

### Task 6: Wire frameStats into `Graph3DView.tsx` (instrument, no visual change)

**Files:**
- Modify: `src/components/graph/Graph3DView.tsx` (imports; refs near line 310; a `recordFrame` callback BEFORE the flush-scheduler init at line 337; one call after each of the 4 `cssRenderer.render(...)` pairs at lines 343, 1099, 1156, 1224; a `showDiagnostics` selector; the overlay `<div>` in the returned JSX)
- Test: none (renderer taps are exercised by the manual verify in Task 9; frameStats math is already unit-tested)

**Interfaces:**
- Consumes: `createFrameStats`, `FrameStatsAccumulator` from `./graph3d/frameStats`.

- [ ] **Step 1: Add the import**

Near the other `graph3d/*` imports at the top of `Graph3DView.tsx`, add:

```ts
import { createFrameStats, type FrameStatsAccumulator } from './graph3d/frameStats';
```

- [ ] **Step 2: Add refs + a `showDiagnostics` selector**

Add the selector beside the other `useStudio` selectors (near line 234):

```ts
  const showDiagnostics = useStudio((s) => s.appSettings.showDiagnostics);
```

Add these refs in the ref cluster (near line 310, after `playbackDriver`):

```ts
  const frameStatsRef = useRef<FrameStatsAccumulator | null>(null);
  if (!frameStatsRef.current) frameStatsRef.current = createFrameStats();
  const lastFrameTsRef = useRef(0);
  const lastStatsPublishRef = useRef(0);
  const statsElRef = useRef<HTMLDivElement | null>(null);
```

- [ ] **Step 3: Add `recordFrame` BEFORE the flush-scheduler init**

Immediately BEFORE the `if (!flushRef.current) {` block (line 337), add this stable callback (it closes over refs only, so it is safe to reference inside the flush body created just below):

```ts
  /**
   * Sample one rendered frame into the pure frameStats accumulator and, at ~2Hz,
   * publish a one-line readout to the diagnostics overlay imperatively (no React
   * re-render). Called right after every renderer.render pair (flush + loops).
   */
  const recordFrame = useCallback(() => {
    const t = threeRef.current;
    const fs = frameStatsRef.current;
    if (!t || !fs) return;
    const now = performance.now();
    const prev = lastFrameTsRef.current;
    lastFrameTsRef.current = now;
    if (prev > 0) fs.sample(now - prev);
    fs.setDrawCalls(t.renderer.info.render.calls);
    if (statsElRef.current && now - lastStatsPublishRef.current > 500) {
      lastStatsPublishRef.current = now;
      const s = fs.read();
      statsElRef.current.textContent = `${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(1)}ms · worst ${s.worstMs.toFixed(1)}ms · ${s.drawCalls} draws`;
    }
  }, []);
```

- [ ] **Step 4: Tap all four render sites**

After EACH of the four `t.cssRenderer.render(t.scene, t.camera);` lines (the flush body ~line 343, and the three direct-render loops ~1099, ~1156, ~1224), add on the next line:

```ts
        recordFrame();
```

(Match the surrounding indentation at each site. There are exactly four `cssRenderer.render` calls — verify with `rg -n "cssRenderer.render" src/components/graph/Graph3DView.tsx` before and after; all four get the tap.)

- [ ] **Step 5: Add the diagnostics overlay to the returned JSX**

Find the graph toolbar block (the `<div className="graph-toolbar-sep" />` at line 1654 sits inside it). Immediately AFTER the toolbar's closing — i.e. as a sibling near the top of the view's rendered tree — add the overlay, gated on `showDiagnostics`:

```tsx
        {showDiagnostics && <div className="graph3d-stats" ref={statsElRef} aria-hidden="true" />}
```

Place it adjacent to the existing toolbar JSX so it lives inside the same viewport container (it is absolutely positioned by CSS in Task 8). If unsure of the exact node, put it immediately before the `<div className="graph-toolbar-sep" />` line's parent toolbar `<div>` closes — anywhere inside the main returned fragment is fine since positioning is absolute.

- [ ] **Step 6: Typecheck + full suite (no behavior change expected)**

Run: `cd ~/lumendeck && npx tsc --noEmit && npx vitest run`
Expected: clean types, full suite green. No test asserts pixels here; the instrument is validated live in Task 9.

- [ ] **Step 7: Commit**

```bash
cd ~/lumendeck && git add src/components/graph/Graph3DView.tsx && git commit -m "feat(fabric): tap frameStats at the 4 render sites + diagnostics overlay"
```

---

### Task 7: Mount the fabric + toolbar toggle in `Graph3DView.tsx`

**Files:**
- Modify: `src/components/graph/Graph3DView.tsx` (imports; `graph3dEffects` selector; `fabricRef` + `clampWarnedRef`; a fabric lifecycle effect; well-refresh appended to the orb-reconcile effect at ~line 700; a toolbar toggle after the Orbs⇄Cards button at ~line 1665)
- Test: none new (fabric math is unit-tested; wiring is verified live in Task 9)

**Interfaces:**
- Consumes: `createFabric`, `type FabricHandle`, `type FabricTier`, `MAX_WELLS` from `./graph3d/fabric`; `resolveCssColor` (already imported).

- [ ] **Step 1: Add imports + selector + refs**

Add the import near the other `graph3d/*` imports:

```ts
import { createFabric, MAX_WELLS, type FabricHandle, type FabricTier } from './graph3d/fabric';
```

Add the selector beside the other `useStudio` selectors (near line 234):

```ts
  const graph3dEffects = useStudio((s) => s.appSettings.graph3dEffects ?? 'off');
```

Add the refs in the ref cluster (near line 310):

```ts
  const fabricRef = useRef<FabricHandle | null>(null);
  const clampWarnedRef = useRef(false);
```

- [ ] **Step 2: Add the fabric lifecycle effect**

Add this effect AFTER the orb-reconcile effect (i.e. after line 702, the `}, [ready, workflow, selectedNodeId, graph3dStyle, capsuleAccent, requestRender]);` close). It constructs/disposes the fabric when the flag flips or the tier changes — **no per-frame work, no new loop**:

```ts
  // ---- gravity fabric lifecycle (constellation GPU overhaul, First Slice) ----
  // Own Group beside the GridHelpers; constructed only when the flag is on, at
  // the tier's density; disposed on flag-off / tier-change / unmount. Wells are
  // refreshed by the orb-reconcile effect below (graph changes), redrawn via the
  // dirty-flag scheduler — there is deliberately NO animation loop here.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    fabricRef.current?.dispose();
    fabricRef.current = null;
    if (graph3dEffects === 'off') { requestRender(); return; }
    const host = viewportRef.current ?? document.documentElement;
    const shallow = resolveCssColor('var(--ld-cyan)', host);
    const deep = resolveCssColor('var(--ld-violet)', host);
    const tier: FabricTier = graph3dEffects === 'minimal' ? 'minimal' : graph3dEffects === 'rich' ? 'rich' : 'standard';
    const fabric = createFabric(tier, shallow, deep);
    fabric.update(useStudio.getState().workflow.nodes);
    t.scene.add(fabric.group);
    fabricRef.current = fabric;
    clampWarnedRef.current = false;
    requestRender();
    return () => {
      fabricRef.current?.dispose();
      fabricRef.current = null;
      requestRender();
    };
  }, [ready, graph3dEffects, requestRender]);
```

- [ ] **Step 3: Refresh wells inside the orb-reconcile effect**

In the orb-reconcile effect, find its final `requestRender();` (line 701, the one just before the `}, [ready, workflow, ...]` dep array at 702). Immediately BEFORE that `requestRender();`, insert:

```ts
    // Fabric wells track graph mass. Refresh here (the effect already re-runs on
    // any workflow/selection change); no-op when the fabric flag is off.
    const fab = fabricRef.current;
    if (fab) {
      const { clamped } = fab.update(workflow.nodes);
      if (clamped && !clampWarnedRef.current) {
        console.warn(`LumenDeck: more than ${MAX_WELLS} weighted nodes — the fabric shows the ${MAX_WELLS} deepest wells.`);
        clampWarnedRef.current = true;
      } else if (!clamped) {
        clampWarnedRef.current = false;
      }
    }
```

- [ ] **Step 4: Add the toolbar toggle**

In the toolbar JSX, immediately AFTER the closing `</button>` of the "Orbs ⇄ Cards" button (line 1665), add:

```tsx
        <button
          className="btn"
          type="button"
          aria-pressed={graph3dEffects !== 'off'}
          onClick={() => updateAppSettings({ graph3dEffects: graph3dEffects === 'off' ? 'standard' : 'off' })}
          title={graph3dEffects === 'off'
            ? 'Gravity fabric off — turn on (mass warps the spacetime grid)'
            : 'Gravity fabric on — turn off'}
        >
          Fabric {graph3dEffects === 'off' ? 'Off' : 'On'}
        </button>
```

- [ ] **Step 5: Confirm disposal safety**

The unmount cleanup at lines 565-593 calls `disposeObject3D(scene)` which traverses and disposes the fabric mesh's geometry+material (they live under the scene). The lifecycle effect's own cleanup also disposes on flag-off/tier-change/unmount. This double-path is safe: `dispose()` is idempotent (Task 5 test) and `group.parent?.remove` no-ops if already detached. **No edit needed** — just verify by reading lines 582-583 that `disposeObject3D(scene)` runs before `orbGeometry.dispose()`.

- [ ] **Step 6: Typecheck + full suite**

Run: `cd ~/lumendeck && npx tsc --noEmit && npx vitest run`
Expected: clean types, full suite green.

- [ ] **Step 7: Commit**

```bash
cd ~/lumendeck && git add src/components/graph/Graph3DView.tsx && git commit -m "feat(fabric): mount gravity fabric group + well refresh + toolbar toggle"
```

---

### Task 8: Diagnostics overlay CSS

**Files:**
- Modify: `src/styles/graph3d.css` (append one rule)

- [ ] **Step 1: Append the overlay style**

Append to `src/styles/graph3d.css`:

```css
/* Live frame-stats overlay (shown only when Diagnostics is enabled). */
.graph3d-stats {
  position: absolute;
  bottom: 10px;
  left: 10px;
  z-index: 6;
  padding: 4px 8px;
  border-radius: 6px;
  font: 500 11px/1.4 var(--ld-mono, ui-monospace, monospace);
  color: var(--ld-cyan, #34d6f4);
  background: rgba(7, 20, 38, 0.72);
  border: 1px solid rgba(52, 214, 244, 0.25);
  pointer-events: none;
  white-space: nowrap;
}
```

- [ ] **Step 2: Typecheck (CSS has no test; ensure nothing broke)**

Run: `cd ~/lumendeck && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ~/lumendeck && git add src/styles/graph3d.css && git commit -m "feat(fabric): diagnostics frame-stats overlay style"
```

---

### Task 9: Manual dev-server verification + measured claim

This is the slice's real proof: the shader only runs on a GPU, which vitest (node env) cannot exercise. Drive the actual app with the preview tools, verify the five behaviors, and capture the measured frame-time claim.

**Files:** none (verification only; may add `.claude/launch.json` if absent)

- [ ] **Step 1: Ensure a dev-server launch config exists**

Confirm `~/lumendeck/.claude/launch.json` has a `lumendeck-dev` entry (`npm run dev -- --host 127.0.0.1`, port 5178 per project memory). If missing, create it with that command/port.

- [ ] **Step 2: Start the server and open the 3D graph**

Use `preview_start` (name `lumendeck-dev`). Then in the preview: navigate to the Graph view, ensure 3D mode is active (the `2D ⇄ 3D` toggle), and confirm the seeded 10-node default workflow is present.

- [ ] **Step 3: Baseline (flag off) — capture identical-scene evidence**

With `graph3dEffects` unset (default), `preview_screenshot` the 3D graph. Then `preview_console_logs` (level error) — expect none. Confirm no fabric plane is visible (no ground dimples). This is the "flag off = identical scene" check.

- [ ] **Step 4: Turn the fabric on**

`preview_click` the new "Fabric Off" toolbar button. Verify via `preview_screenshot`: a translucent grid-height plane appears with visible depressions under weighted nodes (the sampler/rack/hires orbs) and **flat** fabric under weightless nodes (prompt/model), plus luminance contour rings around each well, fading to nothing at the edges (DOM background shows through — no opaque slab). Confirm the DOM node cards/chips still composite correctly over it.

- [ ] **Step 5: Read the measured claim**

Open Settings → enable Diagnostics (`showDiagnostics`), return to the 3D graph. The `.graph3d-stats` overlay shows `fps · ms · worst · draws`. Interact (drag a node, edit a param) so the reconcile effect fires and the overlay updates. Record the frame-time figure with the fabric ON vs OFF at ~10 nodes. Note the delta — the spec's target is ≤2ms added at mid tier (this machine is an RTX 4060-class dGPU per project memory, so expect comfortably under). Capture the overlay text via `preview_inspect` (`.graph3d-stats`, read `textContent`).

- [ ] **Step 6: Reduced-motion + clamp spot checks**

- `preview_resize` with `colorScheme` is irrelevant; instead emulate reduced motion by toggling the OS/browser setting is not available — instead verify the *static-correctness* claim directly: the fabric has no animation loop, so a settled screenshot taken 3s apart is identical (take two `preview_screenshot`s a few seconds apart with no interaction; they must match — proves "no idle animation burn").
- Clamp path: this is covered by the unit test (Task 4) — no manual step needed.

- [ ] **Step 7: Record findings**

Write the measured on/off frame-time numbers and the screenshots' outcomes into the commit message of Task 10 (or a short note appended to the plan). Use measured-only language (no fps promises beyond what the overlay showed).

- [ ] **Step 8: Stop the server**

`preview_stop` the `lumendeck-dev` server.

---

### Task 10: Final gate, verify skill, finish the branch

**Files:** none (gate + integration)

- [ ] **Step 1: Full green gate**

Run: `cd ~/lumendeck && npx vitest run && npx tsc --noEmit`
Expected: entire suite green (prior baseline + new frameStats/fabric tests), zero type errors. If either fails, STOP and fix before proceeding — do not claim completion on red.

- [ ] **Step 2: Confirm the flag-off invariant in code**

Re-read the fabric lifecycle effect: when `graph3dEffects === 'off'` it disposes any fabric and returns before constructing anything; the orb-reconcile well-refresh is guarded by `if (fab)`. Confirm no other code path constructs a fabric. This is the "flag off ⇒ no new code in the render path" guarantee.

- [ ] **Step 3: Update the project memory**

Append to `~/.claude/projects/C--Users-xhan1/memory/lumendeck-project.md` a note that the constellation fabric First Slice shipped (branch name, the flag, the modules, the measured number from Task 9), and update the one-line pointer in `~/.claude/projects/C--Users-xhan1/memory/MEMORY.md`.

- [ ] **Step 4: Finish the development branch**

Use superpowers:finishing-a-development-branch to present merge/PR options. The work is additive, flagged-off-by-default, and fully green — the natural options are open a PR against `main` or fast-forward merge. Do not force-push or reset.

---

## Self-Review

**Spec coverage (First Slice bullets → tasks):**
- `frameStats.ts` pure EMA + draw-call snapshot → Task 2. Surfaced as "one Diagnostics line" → Task 6 overlay + Task 8 CSS. ✓
- `fabric.ts` 128×128 (standard-tier) plane, ≤64 wells from `orbWorldCenter`+`weightT`, analytic gaussian vertex displacement, `fwidth` contours + depth tint, `fog:false`/alpha-fade/`depthWrite:false`/`renderOrder:-1`, CPU mirror for tests, no ripples/particles/bloom/textures → Tasks 4-5. ✓
- `encodings.ts` seeded with the single mass→well entry, rule applies from the first encoding → Task 3. ✓
- `graph3dEffects?: 'off'|'minimal'|'standard'|'rich'` final enum, sanitize accepts four, default off, flag-off ⇒ never constructed → Task 1 + Task 7 lifecycle. ✓
- Own Group beside GridHelpers; wells refreshed in the orb-reconcile effect; redraw via `requestRender()`; no new animation loop → Task 7. ✓

**Placeholder scan:** every code step shows complete code; every command shows the exact invocation and expected result. The Task 3 test block contains a deliberate "do NOT add that import" corrective note (a false-start barrel import) followed by the real import — that is intentional guidance, not a placeholder. No `TODO`/`TBD`/"similar to"/"add appropriate…" remain.

**Type consistency:** `FrameStatsAccumulator`/`FrameStats`/`createFrameStats` (Tasks 2, 6) match. `Well`/`packWells`/`fabricDisplacement`/`MAX_WELLS`/`FABRIC_SEGMENTS`/`FabricTier`/`FabricHandle`/`createFabric` (Tasks 4, 5, 7) match. `Graph3DEffects`/`graph3dEffects`/`sanitizeAppSettings` (Tasks 1, 7) match. `EncodingLayer`/`ENCODINGS`/`unregisteredLayers`/`registeredLayers` (Task 3) match. Uniform packing (`vec4(x, z, depth, sigma)`) is consistent between the GLSL comment, `createFabric.update`, and `fabricDisplacement`'s `dz = x - w.x` / `w.y = z` mapping. ✓

**Scope:** single subsystem (one visual layer + its instrument + its registry seed + one flag). Independently mergeable, flagged off by default. ✓
