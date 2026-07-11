# UI Glass Cinema — glassmorphism shell, starfield, splash, autohide chrome

**Status:** approved (brainstorm 2026-07-11 via UUPM design intelligence), autonomous
execution authorized.
**Branch:** `feature/ui-glass-cinema` (off main, independent of PR #44).

## Goal

Make the whole interface feel cinematic and alive: glassmorphism chrome over an
always-on ambient star/particle field, a constellation splash screen on every
launch, a disciplined app-wide motion language, and auto-hiding navigation
chrome (NavRail + topbar) so the content gets the full window.

User-approved decisions:
- **Autohide:** BOTH the NavRail and the topbar (pin toggle to opt out).
- **Splash:** every launch, plays fully (~2.4s), no skip.
- **Particles:** app-wide, every view (including behind the 3D graph), always
  full density. The ONLY gate is `prefers-reduced-motion` (standing a11y
  invariant): static single-frame starfield, no animation.
- **Style:** UUPM "Modern Dark Cinema" glass — dark translucent surfaces
  (`rgba(18,22,29,.55)`), hairline `rgba(255,255,255,.09)` borders, 18px
  backdrop blur, radius 16, expo-out easing `cubic-bezier(0.16,1,0.3,1)`,
  accent glow. Existing MD3 color tokens stay the single color source.

## Architecture choice (approved: B)

One shared **2D-canvas starfield engine** drives both the splash (dense,
choreographed) and the persistent ambient background (calm). 2D canvas — NOT a
second WebGL context: the 3D graph already owns one and live-context caps have
bitten this codebase before (forceContextLoss in Graph3DView). Rejected: CSS-only
(can't do constellations/shooting stars), second three.js scene (context risk).

## Components

### 1. Starfield engine (pure) — `src/ui/starfield/engine.ts`
- Seeded mulberry32 PRNG (no Math.random), normalized 0..1 coordinates.
- State: stars (pos, size, twinkle phase/speed, drift), dust drifters,
  constellation links (star-index chains with draw-in progress → hold → fade),
  at most one shooting star at a time (spawned at seeded intervals).
- `createStarfield(opts {seed, starCount, dustCount, constellations})`,
  `stepStarfield(state, dt)` (pure, dt clamped ≤ 50ms), and
  `renderStarfield(ctx, state, w, h, alpha)` — step/render split so the
  simulation is unit-testable without DOM/canvas.
- `splashPhase(tMs)` — pure choreography curve for the splash: returns
  `{starsAlpha, linesProgress, wordmarkAlpha, liftT, done}` per timestamps
  0 fade-in → 300ms stars stagger in → 800ms constellation lines draw →
  1600ms wordmark glow-in → 2200ms lift-away → done at ~2400ms.

### 2. `StarfieldCanvas.tsx` — the ambient layer
- One fixed full-window canvas behind the shell (z-index 0, pointer-events
  none). rAF loop with dt clamp; pauses when `document.hidden`; ResizeObserver
  sizing; devicePixelRatio capped at 2.
- Reduced motion: renders ONE static frame (stars visible, nothing animates)
  and never starts the loop.
- Full density always (~300 stars + ~40 dust + constellation lines + shooting
  stars); ~340 sprites on a 2D canvas is trivial per frame.

### 3. `SplashScreen.tsx` — every launch
- Own dense canvas instance (same engine) + wordmark, overlaid at top z. Plays
  the full `splashPhase` choreography, then unmounts; the ambient canvas below
  is the same visual language, so the handoff reads as the splash dissolving
  into the running app. The app boots behind it (probeBridge etc. unchanged) —
  zero added startup latency.
- Reduced motion: static logo + stars, 800ms opacity fade, then unmount.

### 4. Autohide chrome — `src/ui/chrome/chromeVisibility.ts` + `useAutoHide`
- Pure state rule: `chromeVisible({pinned, hovering, focusWithin, nearEdge,
  msSinceReveal, idleMs})` — visible while pinned/hovered/focused/near-edge, or
  within the idle grace after a reveal. Unit-tested; the hook just wires
  timers + pointer/focus listeners (throttled pointermove; edge proximity
  = pointer within 24px of that screen edge).
- Topbar slides up to a slim strip; NavRail slides left. Transform/opacity
  only, 240ms expo-out reveal / 160ms ease-in hide. NEVER hides while focus is
  within (keyboard-safe). Main pane goes full-bleed underneath.
- Pin toggle (in the topbar) persists `appSettings.chromeAutohide?: boolean`
  (optional + additive; undefined = autohide ON per the user's choice).
- Reduced motion: opacity-only 150ms (no slide).

### 5. Glass + motion language — `src/styles/glass.css` + token additions
- Tokens (tokens.css): `--glass-surface`, `--glass-surface-strong`,
  `--glass-fill` (translucent, NO blur — for cards nested inside glass),
  `--glass-border`, `--glass-blur: 18px`, `--glass-radius: 16px`,
  `--ease-expo`, `--dur-1: 150ms`, `--dur-2: 240ms`, `--dur-3: 400ms`.
- `.glass` utility: translucent surface + backdrop-filter blur + hairline
  border + radius; `@supports not (backdrop-filter: blur(1px))` falls back to
  the solid `--ld-surface`. **One blur layer per region** — children of a glass
  surface use `--glass-fill`, never nested backdrop-filter (GPU cost rule).
- Applied to the chrome: topbar, NavRail, graph palette/toolbar, motion dock,
  chips. Panels/cards in views get `--glass-fill` translucency so the starfield
  glows through without compounding blur.
- Motion: view switches crossfade + 12px rise (240ms, keyed wrapper on the
  main pane); `.stagger-in` utility (30–40ms/item entrance, first 8 children)
  applied to Mission Control / Overview card grids; hover lift + accent glow;
  press scale 0.97 (120ms). All transform/opacity; every animation inside
  `@media (prefers-reduced-motion: no-preference)` or disabled by the existing
  reduced-motion blocks.
- Contrast: glass surfaces stay dark enough that existing MD3 text tokens keep
  ≥4.5:1 (blur + 55–75% opacity over a dark field); verified in review pass.

### 6. Graph view transparency
`.graph3d-wrap`'s CSS background gains transparency so the ambient starfield
shows through behind the 3D scene (whose canvas is alpha-transparent except the
cinematic tier's opaque dome, which correctly covers it). The 3D scene's own
spacetime layers are untouched.

## Files

New: `src/ui/starfield/engine.ts`, `src/ui/starfield/StarfieldCanvas.tsx`,
`src/ui/SplashScreen.tsx`, `src/ui/chrome/chromeVisibility.ts`,
`src/ui/chrome/useAutoHide.ts`, `src/styles/glass.css`,
`tests/starfield.test.ts`, `tests/chromeVisibility.test.ts`.
Modified: `src/App.tsx`, `src/components/shell/NavRail.tsx`,
`src/styles/tokens.css`, `src/styles/app.css`, `src/styles/graph3d.css`,
`src/state/appSettings.ts`, `src/main.tsx` (import glass.css).

## Testing

- Engine: deterministic (same seed ⇒ identical states after N steps), twinkle
  bounds, positions stay in [0,1] (wrap), dt clamp, constellation link
  lifecycle (draw→hold→fade→respawn), shooting star bounded lifetime.
- `splashPhase`: monotonic phases, done at the end, values in [0,1].
- `chromeVisibility`: pinned always visible; focusWithin blocks hiding; idle
  grace expiry hides; near-edge reveals.
- appSettings: `chromeAutohide` sanitize round-trip.
- Visual/interaction verified live in the browser preview (splash run, glass
  render, autohide reveal/hide, console clean); adversarial review workflow on
  the diff before push.

## Non-goals / constraints

- No new dependencies. No second WebGL context. No changes to the 3D graph's
  render loops or PR #44's files beyond the `.graph3d-wrap` background.
- Existing reduced-motion blocks stay authoritative; ambient layers are
  background (below content), micro-interactions stay in the 150–300ms band
  (UUPM discipline).

## Known risks

- backdrop-filter cost on WebView2 — controlled by the one-blur-per-region
  rule; worst case a few large blurred chrome surfaces.
- Autohide discoverability — mitigated by slim glow strips at the edges and
  the pin toggle.
- Always-on rAF (ambient canvas) — new steady-state cost by explicit user
  choice; hidden-tab pause + dpr cap bound it; reduced-motion gets a static
  frame.
