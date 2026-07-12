# Fluid Mist — smoke and nebula around planets and orbs (2026-07-11)

Data-driven volumetric-feeling smoke/mist for BOTH 3D surfaces — the Open
Constellation "Universe" view (planets) and Graph mode (orbs) — moving on a
genuine incompressible flow field with interactive wakes, pulses, and eddies.
Approved decisions: **data-driven on both surfaces · body shrouds + nebula
banks, quality-tiered · interactive fluid · hybrid rendering (curl-noise
particle smoke + bounded billboard mist shells) · built on
`feature/open-constellation` (PR #48).**

## Architecture

Two shared modules under `src/components/graph/graph3d/` (both surfaces
already import from there), integrated per surface:

- `flowField.ts` — PURE. `velocityAt(p, t, ctx, out)` composes:
  - **curl of FBM value noise** (divergence-free ⇒ incompressible swirl;
    numerically testable: divergence ≈ 0),
  - **wakes**: each moving body contributes `bodyVelocity · gaussian(|p−body|/r)`
    — bodies drag mist along their orbital paths,
  - **pressure pulses**: expanding radial rings from events (promotion),
    analytic decay like the fabric ripples, ≤4 concurrent, oldest dropped,
  - **hover eddy**: a small rotational kernel around the hovered body.
  All terms are pure functions of `(position, time, bodies, events)`;
  particle positions are the only state (clamped dt, deterministic seeded
  spawns — the `particles.ts` religion). Escape hatch (NOT pre-built): bake
  the curl term into a coarse grid (gravity-grid pattern) if profiling
  demands.
- `mist.ts` — three-only builders:
  - `emissionFor(...)` — PURE mapping from data → emission/density budgets.
  - `createMistSmoke(count, palette, opts)` — ONE `THREE.Points` layer per
    surface: soft procedural sprites (2-octave noise alpha in
    `gl_PointCoord`, **no texture assets**), NORMAL blending at low alpha
    (smoke, not glow), per-particle color attribute from the source body,
    perspective size attenuation, age fade-in/out, `advance(dt, flowCtx)`,
    `dispose()`. GLSL3.
  - `createMistShell(radius, colors)` — one camera-facing quad per body,
    ~1.3× body radius: 2 FBM samples warped by the same flow field, radial
    alpha falloff, depth-tested / no depth-write, `renderOrder` after the
    body. Fragment cost bounded by the body's screen footprint — no
    raymarch loop. GLSL3.

**Division of labor:** Universe = shells + wisps + nebula banks (fixed
deterministic bank emitter sites at rich+). Graph mode = **wisps only** —
orbs already carry atmosphere/ring-dial/emissive, and a shell would fight
ring-drag hit-testing and raycast picking.

## Data encodings (registry-honest)

| Surface | Datum | Mapping |
|---|---|---|
| Universe | `node.status` | `forming` = dense slow-churning shroud (still condensing) · `dormant` = thin near-static desaturated haze · `active` = light energetic wisps · `complete` = clear + rare faint wisp. `strength` scales emission ±30%. |
| Graph | `nodeMeta.lastActiveAt` (existing luminosity datum) | Recently-touched orbs visibly steam; emission decays on the same 45 s half-life as the glow. |

`graph3d/encodings.ts` gains a `mist` layer entry (covered by the
no-layer-without-a-datum test). The Universe mapping is documented in
`docs/constellation.md`. Anomaly is deliberately NOT mist-coupled — it owns
the palette-breaking channel.

## Invariants

- **Idle-sleep (Graph):** mist advances only inside loops that already run
  (rich+ ambient animator, playback, audio, settle decay). Below those tiers
  it renders as a static deterministic arrangement via the dirty-flag
  scheduler. The "provably sleeps" invariant is untouched.
- **Reduced motion:** Universe — flow time frozen (dt=0: no spawning, no
  advection), shells keep their data-driven density so the status encoding
  survives motionless. Graph — steam is disabled entirely under reduce (the
  same `motionPolicy` gate as the dust); no information is lost because the
  luminosity glow carries the identical datum statically. The Universe gate is
  a LIVE `matchMedia` listener; the graph gate is snapshot-at-mount, matching
  its host surface's precedent (dust/pulses/fabric all read the preference
  once per lifecycle effect) — an OS toggle mid-session applies on the next
  remount or tier change.
- **Hidden tab:** existing draw-skip + dirty-sync semantics cover mist (it
  ticks with the surface's loop).
- **Photosensitivity:** mist is low-luminance and moves geometry, not
  brightness; no flashes ⇒ no flash-limiter interaction (by design).
- **Compositing:** normal blending, `depthWrite: false`, `fog: false`,
  drawn above bodies but below labels; zero new render targets, zero
  readbacks, zero texture assets (MSI unaffected). Colors resolved from
  tokens before THREE (`resolveCssColor`).
- **StrictMode / lifecycle:** every handle owns disposal; integrated into
  each surface's existing mount/unmount + `forceContextLoss` path.

## Performance budget

- Draw calls: Universe ≤13 extra (1 smoke layer + ≤12 shells); Graph +1.
  Shells are HARD-CAPPED at 12 (densest-first; center always keeps its
  shroud) because satellite counts are unbounded real user data.
- Smoke sprite counts per tier — Universe 350/900/1500, Graph 250/600/1000
  (standard/rich/cinematic; minimal & off = none, static shells only at
  standard in Universe).
- CPU ≤1.2 ms at rich: 1500 × (4 noise evals + ≤12 wake gaussians); wake
  bodies are capped at the 12 largest satellites. The coarse-grid escape
  hatch is the named fallback if measured over budget.
- Adaptive governor sheds in order (implemented as shed stages = how far the
  adaptive cap falls below the configured tier): nebula banks off (≥1) →
  wisp rates halve (≥2) → shells go static (≥3); recovery is symmetric.

## Testing

- `flowField`: numeric divergence ≈ 0 for the curl term; wake aligns with
  body velocity; pulse decays to zero within its lifetime; deterministic;
  out-param writes without allocation.
- `mist`: `emissionFor` mapping (status/activity → budgets, strength
  scaling, half-life decay); material construction flags (normal blending,
  no depth-write, GLSL3, uniforms present); `advance` NaN-free under
  starve/resume (clamped dt); respawn/lifetime bounds.
- `encodings`: registry gains `mist`; exclusivity walk stays green.
- Live verification on BOTH surfaces: shroud on a `forming` node, steam on
  a freshly-edited orb, promotion pulse, reduced-motion freeze, console
  clean, tier downgrade path.

*Approved by the user 2026-07-11 (design presented section-by-section in
session; "yes and build it autonomously").*
