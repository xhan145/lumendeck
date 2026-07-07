# LumenDeck — Audio Reactivity (Living Constellation Phase 3, 2026-07-06)

Live audio drives the constellation: a Web Audio analyser turns sound into frequency bands, bands
drive orb motion/values/ring in real time, and a reactive performance can be **baked into a Motion
clip** (which then plays and renders via Phases 1–2). Realizes vision-doc Phase 3.

## Honest scope
Audio is analysed **client-side** (Web Audio API) — no bridge, no GPU. Sources: an **audio file**
(decodeAudioData) and the **microphone** (getUserMedia; permission required — denial shows a loud
message, never a fake signal). A built-in **oscillator test tone** is offered too so the feature is
deterministically demoable without a mic. Reactivity is a live **preview overlay** (like motion
playback): it moves orbs and re-tints gradients/rings but does NOT write workflow params every frame
(that would storm persistence). To persist, the user **bakes** N seconds → a Motion clip.

## Core (pure, tested) — `src/core/audio/`
- `bands.ts`: `computeBands(freqData: Uint8Array, layout) -> { bass, mid, treble, level }` (and an
  N-band variant) — averages FFT bins into normalized 0..1 bands; `smooth(prev, next, factor)`
  one-pole smoothing so motion isn't jittery. Pure.
- `mapping.ts`: `AudioMapping = { targets: { band: 'bass'|'mid'|'treble'|'level'; kind: 'x'|'y'|'z'|
  'ring'|'scale'; nodeId: string; gain: number }[] }`; `applyAudio(bands, mapping, base) ->
  { offsets: Map<nodeId, {dx,dy,dz,scale}>, ringValues: Map<nodeId, number> }` — pure translation
  of bands into per-orb visual reactions. `DEFAULT_MAPPING(workflow)` wires bass→scale/ring of the
  sampler orb, mid→X, treble→Y by default. Deterministic.
- `audioToClip.ts`: `audioToClip(samples, mapping, nodeId) -> MotionClip` — reuses the Phase-1/2
  keyframe + `pathToClip` conventions (stable ids, wall-clock times) to bake a reactive capture.

## Engine (browser) — `src/audio/engine.ts`
A small `AudioEngine` wrapping `AudioContext` + `AnalyserNode`: `start(source)` where source ∈
`{file: ArrayBuffer} | {mic: true} | {tone: hz}`; exposes `read() -> Uint8Array` (current FFT);
`stop()` tears down nodes + released mic tracks. React-free; UI polls `read()` from the existing 3D
render loop's rAF while the view is mounted (audio reactivity only matters on-screen, so rAF is
acceptable here — unlike playback/recording; still, the engine is cancelled on unmount so nothing
leaks). Guards: no `AudioContext` / getUserMedia rejection → loud status, engine stays stopped.

## State + wiring
- `src/state/audio.ts`: `AudioState = { source, running, mapping, sensitivity }` + `defaultAudioState`
  + `hydrateAudio` (additive optional persist of mapping+sensitivity; `running`/source never
  persisted — a reload never auto-listens to the mic). Store actions: `startAudio(source)`,
  `stopAudio`, `setAudioMapping`, `setAudioSensitivity`, `bakeAudioClip(seconds)`.
- Graph3DView reactive tick: while `audio.running`, each frame read bands → `applyAudio` → set the
  same transient orb offset/ring path the motion-playback preview uses (reuse that code; the two
  never run at once — starting audio pauses motion playback and vice-versa). Cancelled on unmount +
  via `stopAudio`.
- Bake: `bakeAudioClip(seconds)` records bands→positions over the window (wall-clock sampler, the
  starvation-safe pattern) → `audioToClip` → adds to the motion slice + sets active.

## UI — Audio panel (in the Motion/graph dock)
Source picker (File / Mic / Test tone), Start/Stop, a compact band→target mapping list (add/remove:
band, target axis/ring/scale, node, gain), a sensitivity slider, a live level meter, and
"Bake N s → clip". Disabled-with-tooltip when not on the 3D view. a11y: labels/roles/reduced-motion.

## Testing & verification
- **Pure vitest**: `computeBands` (bin averaging, normalization, N-band split), `smooth`
  (converges, factor bounds), `applyAudio` (band→offset/ring per target + gain), `audioToClip`
  (tracks/keyframes/ids/times, empty case). All existing 399 tests stay green; tsc clean.
- **Browser smoke**: start the **test-tone** source (deterministic, no mic) → orbs visibly react
  (offsets/ring change with the tone), level meter moves; switch tone hz → reaction changes; Bake
  3 s → a clip appears in the motion timeline and plays; Stop → orbs return to rest, no console
  errors; mic-denied path shows the loud message.
- No bridge/GPU needed.

## Acceptance
1. Test-tone (or an audio file) makes orbs pulse/drift and rings sweep in real time.
2. Bake turns a reactive capture into a Motion clip that plays (Phase 1) and can render (Phase 2).
3. Mic requires permission; denial is loud; a reload never auto-listens.
4. Audio and motion playback never fight; orbs rest cleanly on stop; 399+ tests green; tsc clean.
