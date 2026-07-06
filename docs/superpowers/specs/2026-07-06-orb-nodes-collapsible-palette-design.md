# LumenDeck — Orb Nodes + Collapsible Palette (2026-07-06, v0.13.0)

Evolve the 3D graph from "cards floating in space" into a workflow no other node editor has:
a **constellation of gradient orbs** you orbit around, where **color encodes each node's weight**,
and **focusing an orb expands it into its full editor card in place**. Plus: the node palette
**auto-collapses when not in use** so the scene owns the screen. User request verbatim: collapse
the nodes list when not in focus; spherical 3D node shapes; gradiated colors representing weights
and sliders; "a new unseen around the world workflow for node based editing systems."

## 1. Collapsible node palette
- The palette/toolbar (`.graph-toolbar`) auto-collapses to a **slim vertical tab** (icon + "Nodes"
  label rotated, ~40px wide) whenever the pointer AND keyboard focus are outside it; it expands on
  hover, click, or focus-within. A **pin button** keeps it open for users who want the old
  behavior (pinned state persisted in `appSettings.palettePinned`, additive optional field).
- Collapse/expand is a CSS width/opacity transition (respects `prefers-reduced-motion`: instant).
- Keyboard: the collapsed tab is a focusable button (aria-expanded); Escape inside the expanded
  palette collapses and returns focus to the tab. Applies to BOTH the 2D and 3D toolbars via one
  shared `CollapsiblePalette` wrapper component so behavior is identical.

## 2. Orb nodes (the new default 3D style)
- In 3D, each unselected node renders as a **sphere mesh** (WebGL) — a glowing orb — instead of a
  DOM card. Orb surface is a **two/three-stop gradient shader**; selected node gets an emissive
  lift + slight scale pulse (no pulse under reduced motion).
- **Focus = expand:** clicking an orb (or focusing its label chip) expands that ONE node into the
  existing `GraphNode` DOM card in place (CSS3D, same position) for full editing — params, ports,
  keyboard, everything untouched. Deselect/blur collapses it back to an orb. Editing therefore
  loses ZERO capability; the constellation is the resting view, the card is the focused view.
- Each orb carries a small **CSS3D label chip** below it: capsule icon + title + one-line summary
  (reuses `nodeSummary`), plus **mini port dots** (inputs left, outputs right) that reuse the
  existing `onPortDown`/`onPortUp` handlers and candidate/invalid highlighting — so you can wire
  orb-to-orb WITHOUT expanding. Chips are focusable and route the existing keyboard contract
  (arrows move node, Delete removes, Ctrl+D duplicates).
- 3D wires now terminate at orb surfaces (or chip ports when expanded) — endpoint math extends
  `graph3d/projection.ts`.
- A **style toggle in the 3D toolbar: Orbs ⇄ Cards** (persisted `appSettings.graph3dStyle`,
  default `'orbs'`) keeps v0.12's all-cards 3D one click away. 2D view untouched.

## 3. Weight → gradient encoding (pure, tested)
New pure module `src/components/graph/graph3d/orbWeight.ts`:
- `primaryWeight(kind, params) -> { value, min, max, label } | null` — the one number that best
  characterizes each capsule: sampler→cfg (0–30), imageLoader→strength, loraRack→mean enabled
  slot weight, controlNetRack→mean enabled strength, conditioningAverage/latentNoise/control→
  strength, video→motionStrength, hiresFix→denoise, generic fallback→first numeric ParamDef
  normalized by its min/max, else null (no weight → neutral orb).
- `weightT(kind, params) -> number|null` — normalized 0..1.
- `gradientStops(t) -> [lowColor, midColor, highColor]` blended along the brand ramp
  **Ion Cyan `#34D6F4` → Voltage Violet `#7C3AED` → Mango Fuse `#FF8A3D`**: low weights read cool,
  high weights read hot. Category accent tints the base so kinds stay distinguishable.
- Each orb also wears a thin **equatorial ring arc** (torus segment) sweeping 0→360° with the
  normalized value — the "slider made visible." Ring arc angle = `t * 2π`, same ramp color.
- Editing a param live-updates gradient + ring (subscribe to workflow params; dirty-flag render).

## Testing & verification
- **Pure unit (vitest):** `primaryWeight` per-kind extraction incl. mean-of-enabled-slots and the
  generic fallback + null case; `weightT` clamping; `gradientStops` endpoints/midpoint; ring-arc
  angle mapping. Palette collapse state logic extracted pure if practical. All existing 184 tests
  stay green; tsc clean.
- **Preview smoke:** palette auto-collapses when pointer leaves + expands on hover/focus + pin
  works; orbs render with visibly different gradients for different weights (set cfg low vs
  high); ring arc tracks a param change live; click orb → card expands in place → edit → collapse
  → gradient/ring updated; wire from an orb chip port to another node; Orbs⇄Cards toggle; 2D view
  unchanged; reduced-motion: no pulse, instant palette transitions; no console errors.

## Acceptance
1. Leaving the palette collapses it to a slim tab; the 3D scene is unobstructed. Hover/focus
   brings it back; pinning disables auto-collapse; fully keyboard operable.
2. Unselected nodes are gradient orbs with value rings; a sampler at cfg 2 vs cfg 20 is visibly
   cool vs hot; the ring sweeps accordingly.
3. Clicking an orb expands the full editor card in place; every existing editing capability works
   exactly as in v0.12; collapsing back reflects new values in the gradient.
4. Orb-to-orb wiring works from label-chip ports without expanding.
5. Orbs ⇄ Cards toggle persists; 2D untouched; no schema change; 184+ tests green; tsc clean.
