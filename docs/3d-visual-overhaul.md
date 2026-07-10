# 3D Visual Overhaul — Volumetric Spacetime

Deepens the constellation view shipped in the v0.20 GPU overhaul (PR #29/#30)
into a volumetric, cinematic spacetime: dust that truly occupies 3D space and
orbits the gravity wells (the `4809263` volumetric particle module), directed
energy pulses along wires, a starfield + bloom pipeline, and
measured-performance adaptive quality — all while preserving the standing
invariants (dirty-flag idle sleep, one render per frame, data-encoding
registry, flash limiting, reduced motion, 2D fallback).

## Architecture

New focused modules (nothing new piled into `Graph3DView.tsx` beyond wiring):

| Module | Responsibility |
| --- | --- |
| `graph3d/quality.ts` | PURE tier table (`featuresFor`), reduced-motion policy, shared delta clamp, and the adaptive-quality controller (hysteresis + slow recovery). |
| `graph3d/energyFlow.ts` | Directed pulses along workflow wires. One `Points` object for ≤512 pulses (single draw call); pure bezier/pulse/density math exported for tests. |
| `graph3d/environment.ts` | Deterministic static starfield (parallax depth anchor) and the opaque cinematic backdrop dome. Zero per-frame cost. |
| `graph3d/postprocessing.ts` | Cinematic composer: RenderPass → UnrealBloomPass (threshold 0.85) → CopyPass. |

Reworked modules:

- `graph3d/particles.ts` — the volumetric simulation landed on main in
  `4809263` (kept as-is; see below). This branch feeds it tier-sized particle
  budgets and the brand-cyan cool color.
- `graph3d/fabric.ts` — `cinematic` density tier (256²) and ambient micro-waves
  (`fabricWave` CPU mirror, `setTime`, amplitude 0 = static).
- `graph3d/scene.ts` — orb shader gains procedural surface convection + corona
  shimmer (luminance-only, ±9%, data colors untouched); `wireControl` exported
  so pulses ride the exact rendered wire curve.
- `Graph3DView.tsx` — one `renderScene()` chokepoint (composer-aware) used by
  the flush scheduler, settle driver, playback, audio, and scrub paths; layer
  lifecycles keyed to the *effective* level.

### Volumetric particles (main's `4809263` module)

Each particle integrates: radial gravity pull (bilinear-sampled coarse grid,
O(1) per particle), a tangential orbital force proportional to the local well
height (accretion-like circulation), a vertical spring toward its own altitude
band over the *deformed* surface (dust visibly plunges down well funnels and
lifts back out), and bounded deterministic turbulence. Per-particle energy
combines gravity pull and speed, driving color cool→warm, brightness, sprite
size, and a seeded twinkle. No `Math.random` in any hot path (seeded
mulberry32), no per-frame allocations, `dt` clamped at 50 ms (tab restore
can't fling dust). A separate trail layer was prototyped and dropped in favor
of this variant's energy/twinkle encoding.

## Visual-variable mappings (encodings registry extended)

| Datum | Channel |
| --- | --- |
| Node mass (`weightT`) | Fabric well depth + radius; dust infall/orbit/funnel shape |
| Particle energy (gravity + speed) | Dust color cool→warm, brightness, sprite size, twinkle |
| Workflow edge topology | Pulse existence + travel direction (source → destination) |
| Endpoint activity (`nodeMeta` recency) | Pulse count, speed, brightness (+ orb emissive, pre-existing) |
| Health ERROR on an endpoint | Pulses crawl, dim, stutter (never reverse) |
| Health error/warning (pre-existing) | Palette-breaking anomaly ring; new-error fabric ripple |
| Wire socket type | Pulse color (same resolved token as the wire) |
| Environment (starfield/backdrop) | Registered as non-signaling depth reference — carries no state by design |

## Quality tiers (`graph3d/quality.ts`)

| | fabric | particles | pulses/edge | bloom | starfield | waves |
| --- | --- | --- | --- | --- | --- | --- |
| off | — | 0 | 0 | – | 0 | 0 |
| minimal | 64² | 0 | 0 | – | 0 | 0 |
| standard | 128² | 1 000 | 2 | – | 0 | 0 |
| rich | 192² | 2 600 | 3 | – | 900 | 4 |
| cinematic | 256² | 4 500 | 4 | ✓ 0.55 | 1 400 | 6 |

The palette button cycles off → standard → rich → cinematic → off
(`minimal` remains a valid persisted/adaptive floor). `graph3dEffects` gained
the additive `'cinematic'` value; older persisted blobs load unchanged.

**Adaptive quality**: every rendered frame feeds a controller; an EMA over the
25 ms budget sustained for 2.5 s drops the cap ONE step (floor `minimal`);
recovery needs 15 s of comfortably-fast frames per step — no oscillation by
construction. The cap limits only the expensive layers; **data encodings
(wells, anomaly rings, luminosity) always follow the user setting** —
degradation never removes information. Idle dirty-flag gaps (> 250 ms) and
hidden-tab frames are never fed. The diagnostics overlay shows the effective
tier (` · rich (auto-capped)`).

## Cinematic rendering decisions

- **Bloom-only composer, no ACES/OutputPass** — evaluated and rejected: every
  material here is authored in display-ready sRGB; `OutputPass` assumes a
  linear buffer and its linear→sRGB conversion + filmic curve visibly washed
  the data palette to pastel (verified in-browser). The CopyShader final pass
  preserves the authored look bit-for-bit; threshold 0.85 blooms only genuinely
  bright pixels (orb cores, energized dust, pulse cores, specular glints).
- **Opaque backdrop dome at cinematic only** — UnrealBloomPass cannot preserve
  canvas alpha, so the cinematic tier renders its own deep-space gradient
  (matched to the `.graph3d-wrap` CSS) instead of the transparent canvas. All
  other tiers keep the transparent-canvas contract untouched.
- **CSS3D never post-processed** — the DOM layer composites above the canvas in
  the browser; cards, chips and controls stay crisp by construction.

## Performance safeguards

- One render per frame preserved: playback/audio own the frame; the settle
  driver (now also driving dust/pulses/waves) is mutually excluded via
  `settleShouldRun` exactly as before.
- Hidden tab: ambient loop stays armed but skips all integration + GPU draws.
- `clampDelta` (50 ms) shared by every integrator; pulse phases wrap.
- Single draw call each for dust, pulses, starfield; pulse capacity
  512 with a **warned** (not silent) drop; wells still capped at 64 (warned).
- Pixel ratio remains capped at 2 (pre-existing).
- Explicit pass disposal: `UnrealBloomPass`'s mip render-target chain is
  disposed on every tier change/unmount (EffectComposer.dispose alone leaks it).
- Measured on the dev machine: cinematic tier (4 500 particles +
  pulses + 256² fabric + bloom) at ~143 fps / 7.0 ms.

## Accessibility

`prefers-reduced-motion` silences every *animated* ambient layer via one pure
policy (`motionPolicy`): no dust, no pulses, no ripples, no fabric
waves. Static encodings — wells, contours, anomaly rings, ring arcs, starfield,
luminosity snapshot — remain, so the scene stays informative and calm. Ripples
still pass the shared WCAG flash limiter (≤3 onsets/s). WebGL failure still
falls back to the 2D editor.

## Files changed

- `src/components/graph/graph3d/quality.ts` (new) + `tests/quality.test.ts`
- `src/components/graph/graph3d/energyFlow.ts` (new) + `tests/energyFlow.test.ts`
- `src/components/graph/graph3d/environment.ts` (new)
- `src/components/graph/graph3d/postprocessing.ts` (new)
- `src/components/graph/graph3d/fabric.ts`, `scene.ts`, `encodings.ts`
- `src/components/graph/Graph3DView.tsx`, `src/state/appSettings.ts`
- `tests/fabric.test.ts`

Validation: `npm run typecheck` ✓ · `npm test` 760 passed ✓ · `npm run build` ✓
(main chunk 1 208.17 kB, ~+33 kB / ~+10 kB gzip over the v0.24.0 baseline — the
three.js postprocessing chain).

## Known limitations

- The particle simulation is CPU-side (a deliberate choice: 4.5k particles cost
  well under a millisecond; a GPGPU rewrite wasn't justified by profiling).
- Orb convection/corona and fabric waves freeze while the scene idles at tiers
  without an ambient loop — accepted, since idle stillness is the design
  invariant.
- Adaptive tier changes recreate the particle field (positions re-seed) — a
  one-frame pop, rare by hysteresis.
- Blocked-pulse stutter is subtle at low zoom; the anomaly ring remains the
  primary error signal.
- Dev-only Vite warning about multiple three.js instances can appear once when
  the new example modules are first optimized mid-session; a server restart (or
  production build) has a single three copy.

## Recommended next phase

1. Node-drag wakes: small flash-limited ripples on drag-release, amplitude by
   drag speed.
2. Render-activity particle surges (transient emission bursts at the rendering
   node's well) once per-node render attribution exists.
3. Optional GPGPU particle path behind the same `ParticleField` interface if
   profiling ever shows the CPU sim on the frame's critical path.
4. Selective bloom via layers (bloom only the emissive pass) to let the
   threshold drop without touching the fabric highlight.
