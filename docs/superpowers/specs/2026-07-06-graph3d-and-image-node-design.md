# LumenDeck — 3D Graph (WebGL) + first-class img2img Image node (2026-07-06)

Two approved upgrades to Graph mode: a **full WebGL 3D scene** (three.js, orbitable camera) that
visually separates LumenDeck from ComfyUI's flat canvas, and a **first-class Image node** with an
inline preview that drives img2img. Approved via brainstorming (user: "Full WebGL 3D scene" +
"Image node with inline preview + wire"; ship as v0.12.0).

## Architecture — 3D that never breaks editing

The one hard constraint: node editing (drag, wire, params, keyboard) must stay rock-solid.
So nodes are NOT rebuilt as GL meshes. Instead:

- **CSS3DRenderer** (three/examples/jsm) positions each node's **live DOM card** (the existing
  `GraphNode` component, unmodified interaction contract) on a flat plane in true 3D space.
  Inputs, ports, focus, and keyboard all keep working because they are real DOM.
- A **WebGLRenderer** layer *behind* the CSS3D layer draws the "world": a receding neon ground
  grid (brand cyan/violet), depth fog, and the **wires as 3D curves** (THREE.Line /
  QuadraticBezierCurve3, colored by socket type, additive-glow material). The WebGL canvas is
  `pointer-events: none`; wire-click disconnect is done by manual raycast from container clicks
  (DOM nodes stopPropagation, so only empty-space clicks reach the raycaster;
  `raycaster.params.Line.threshold` for forgiving hits).
- **New component split:** `GraphWorkspace.tsx` wraps the existing 2D `GraphView` and the new
  `Graph3DView` with a **2D ⇄ 3D toggle** (App mounts GraphWorkspace where it mounted GraphView).
  The classic 2D editor remains one click away, byte-identical.

## Camera & interaction (hand-rolled, not OrbitControls — it would fight node drag)
- **Orbit**: drag empty space — spherical coords around a target point, pitch clamped ~[10°, 80°].
- **Dolly**: wheel (distance clamped). **Pan**: shift-drag or middle-drag (moves the target).
- **Node drag**: pointer-down on a node head → unproject the pointer ray onto that node's
  z-plane → `moveNodeTo(x, y)` in existing workflow coords. Wiring drags identically project
  onto the source plane. Existing store actions untouched.
- **Reset camera** + **Fit** buttons; selected node **lifts** toward the camera (+z).
- **Reduced motion / fallback**: `prefers-reduced-motion` defaults the toggle to 2D (3D still
  available); WebGL-unavailable falls back to 2D automatically with a note. Render loop is
  dirty-flag driven (no idle animation burn).

## Z is a view concern — no schema change
`WorkflowNode` keeps `{x, y}` only (schemaVersion 1 untouched, zero migration risk). Depth is
computed deterministically in a pure module: `z = f(x)` (a gentle per-column recession, tuned
constant), `+lift` when selected. Pure math lives in `src/components/graph/graph3d/projection.ts`:
`worldFromNode(node, selected)`, `socketWorldPoint(node, socketId, dir)` (reuses the 2D
`socketPoint` offsets), `pointerRayToPlane(...)` — all unit-tested without a browser.

## Graph mode persistence
`AppSettings` gains optional `graphMode?: '2d' | '3d'` (additive — old persisted state loads).
Default: '3d', except `prefers-reduced-motion` → '2d'.

## First-class img2img Image node
- The existing `imageLoader` capsule becomes a real graph citizen: its **GraphNode body renders an
  inline thumbnail** when `params.image` is set (plus a drop/upload affordance mirroring the
  ParamField image kind), with strength visible in the summary.
- **Sockets:** ensure `imageLoader` exposes an `image` output and the **sampler gains an optional
  `image` input**, so the relationship is expressible as a wire (type-checked by `canConnect`).
- **Activation stays presence-based** (an uploaded image on the Load Image capsule turns on
  img2img exactly as today) — this is deliberate: Recipe-view users never wire edges, and
  edge-gating would silently break their img2img. The wire is the graph's visual/semantic
  expression, not a new gate. Documented in code.
- `nodeSummary` is extracted from GraphView.tsx into a shared `src/components/graph/nodeSummary.ts`
  (both 2D and 3D views consume it) and gains an `imageLoader` case ("img2img @ 0.6" / "No image").

## Dependencies
`three` + `@types/three` (the only new deps; ~150 KB gz). No postprocessing passes (no bloom
pipeline) — glow comes from emissive colors, fog, and the grid. Budget: 60fps at 40 nodes.

## Testing & verification
- **Pure unit (vitest):** projection math (z rule, socket world offsets vs 2D socketPoint, ray→
  plane intersection incl. parallel-ray guard), capsule socket additions (sampler image input,
  imageLoader image output, canConnect validity), nodeSummary imageLoader case. All existing
  167 tests stay green; tsc clean.
- **Browser preview smoke:** toggle 2D⇄3D; orbit/dolly/pan; drag a node in 3D and confirm the
  workflow position updates; draw a wire in 3D; click-disconnect a wire via raycast; upload an
  image on the Image node → thumbnail appears; a mock render with that image produces an
  img2img job (initImage present); reduced-motion default; no console errors.
- img2img GPU path is unchanged (proven in v0.7.0) — no new GPU verification needed.

## Acceptance
1. Graph opens in 3D: nodes float over a receding grid, wires glow in 3D, orbit/dolly/pan work.
2. Dragging nodes and wiring sockets in 3D behaves exactly like 2D (same store, same rules).
3. One click returns to the classic 2D editor; preference persists.
4. An Image node shows its uploaded picture on the node and drives img2img (initImage in the job).
5. No workflow schema change; old saved workflows load; 167+ tests green; tsc clean.
