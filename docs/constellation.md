# Open Constellation

LumenDeck's capabilities as an explorable 3D universe: the selected node is a
custom-shaded central planet, its children orbit as satellites, their children
as subordinate moons. Clicking (or keyboard-activating) a body promotes it to
the center. The world argues the overlay's statement — **FREE. OPEN. YOURS.** —
with energy that only radiates outward and no locked boundary anywhere.

Open it from the nav rail: **Command → Universe** (`ViewId: 'constellation'`).

## Rendering it

```tsx
import { ConstellationView } from './components/constellation/ConstellationView';
// The app view — builds the tree from live store data (capsules, Creative OS
// brains/recipes, gallery collections) and owns selection/history/fallback.
<ConstellationView />
```

For a custom tree, use the scene directly:

```tsx
import { ConstellationScene } from './components/constellation/ConstellationScene';
<ConstellationScene
  root={myRoot}            // ConstellationNode
  centerId={selectedId}
  onPromote={(id) => …}    // selection stays outside — controlled component
  reducedMotion={false}
  quality="standard"       // EffectsLevel: off|minimal|standard|rich|cinematic
  onContextFailed={() => …}
/>
```

## Data shape

```ts
type ConstellationNode = {
  id: string;              // unique across the tree (drives orbits + history)
  label: string;
  description?: string;
  colors: [string, string]; // CONCRETE colors (resolve var() tokens first —
                            // see graph3d/scene.ts resolveCssColor)
  type?: 'core' | 'mission' | 'addon' | 'tool' | 'integration' | 'evidence';
  status?: 'active' | 'forming' | 'dormant' | 'complete'; // dormant = dim body
  strength?: number;       // 0..1 → satellite scale + shader energy
  children?: ConstellationNode[]; // arbitrary depth; children become satellites
};
```

`buildLumenConstellation(input)` (`data.ts`) builds the product tree from real
data — 53 capsules in 11 categories, live Creative OS brains/recipes, gallery
collections — and is safe with a completely empty store. The "Open Core" branch
maps to invariants enforced in code (`localOnlyMode`/`telemetryDisabled` are
hardcoded `true`).

## How children become satellites

Direct children of the selected node orbit the planet on deterministic paths
(`orbits.ts`): radius steps outward per sibling, inclination stays inside a
±0.42 rad legibility band, phase uses golden-angle spacing, and speed follows a
Kepler-ish falloff — all derived from an FNV-1a hash of the node id, so the
same tree always produces the same sky (no Math.random). Each satellite shows
up to `moonCap` (2–4 by tier) of its own children as orbiting moons; deeper
levels stay reachable by promotion. Selecting a satellite grows its system out
of the clicked position while the old system retracts (interruptible).

## Fluid mist (what the smoke means)

Bodies breathe data-driven smoke riding a genuine incompressible flow field
(`graph3d/flowField.ts` — curl of FBM noise, numerically divergence-free, plus
wakes dragged by orbiting satellites, expanding pressure rings on promotion,
and a small eddy stirred around the hovered body). `node.status` encodes the
mist, with `strength` scaling emission ±30%:

| status | mist |
|---|---|
| `forming` | dense, slow-churning shroud — still condensing |
| `dormant` | thin, near-static haze |
| `active` | light energetic wisps |
| `complete` | clear body, rare faint wisp |

Rendering is one `THREE.Points` smoke layer (procedural soft sprites, normal
blending — smoke, not glow; wisps tinted by their body's color) plus a bounded
billboard shell per shrouded body (`graph3d/mist.ts`); no textures, no render
targets, no raymarch. Wisp counts scale per tier (0/350/900/1500) and nebula
banks join at rich+. Under reduced motion the flow time freezes (dt = 0 — no
spawning, no advection) but shells keep their density, so the status encoding
survives motionless. The graph view reuses the same engine for activity steam
(`nodeMeta.lastActiveAt`, registered as `mist-steam` in
`graph3d/encodings.ts`).

## Camera & interaction

Hand-rolled spherical orbit camera (the repo's OrbitControls-equivalent —
`graph3d`'s proven pattern): drag to orbit (damped), wheel/pinch to dolly with
clamped distance, polar angle restricted to prevent flips, pan disabled. After
2.5 s idle it auto-orbits slowly; any pointer/touch input takes over
naturally. Satellite labels are real focusable `<button>`s projected to screen
space — Enter/Space activates, Back pops the selection history (disabled at
the root).

## Quality, performance, reduced motion

- Tiers (`quality` prop, fed from `appSettings.graph3dEffects`): geometry
  detail, 3D-starfield count, moon caps, and bloom (cinematic only, via the
  bloom-only `graph3d/postprocessing` pipeline) scale per tier; `'off'` still
  renders at the minimal tier — this view *is* the content. Note the deliberate
  semantic difference from the graph view, where `'off'` disables its effect
  layers entirely: the Universe always renders and `'off'` only lowers fidelity.
- A `createAdaptiveQuality` governor sheds starfield/bloom under sustained
  slowness; frames are never sampled while the tab is hidden.
- The loop is `createPlaybackDriver` (rAF + timer, starvation-proof); hidden
  windows skip steady-state draws but still sync dirty frames once
  (flushScheduler semantics). dt is clamped (`clampDelta`) so restored tabs
  never lurch. Uniforms animate via the loop — never React state.
- `prefers-reduced-motion` (live listener): auto-orbit off, orbital time and
  shader drift frozen (`uMotion = 0`), broadcast waves stop expanding —
  everything stays parked, lit, and fully explorable by hand.
- Unmount disposes every geometry/material and calls `forceContextLoss()`
  (context caps; StrictMode-safe).

## Fallback / accessibility

WebGL probe failure, runtime context failure, or the **List view** toggle all
render `ConstellationFallback` — the full hierarchy as semantic HTML with the
same selection state (101 nodes for the default tree). The overlay announces
the selected node via a polite live region; copy stays sparse by design.

## Limits

Designed for tens of satellites per system (the product tree tops out at 11);
hundreds of *total* nodes are fine since only the selected system renders.
For future thousand-node systems, add instancing/LOD before raising `moonCap`.
