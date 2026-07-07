# LumenDeck — Living Constellation: the closed-loop render brain (north star)

The constellation graph stops being a *picture of* a workflow and becomes the workflow's **nervous
system**: orbs are semantic agents that move in 3D, and their movement over time *is* the render
program. Preview motion compiles into render instructions; finished frames feed back; the system
explores, scores, and evolves variants toward the user's stated intent. This doc is the north star
every phase aligns to. It is a direction, not a single buildable spec — each phase below gets its
own spec → build.

## The loop
```
        intent (prompt + goals)
                │
   ┌────────────▼─────────────┐
   │  Constellation (orbs)     │  orbs = agents bound to node values, prompts,
   │  move in 3D over a        │  LoRAs, ControlNets, masks, camera, audio-reactive
   │  timeline                 │  params, quality goals
   └────────────┬─────────────┘
                │ motion compiles to
   ┌────────────▼─────────────┐
   │  Render program           │  per-frame RenderJob patches (values, seeds,
   │  (keyframed curves)        │  prompt weights) via variations + AnimateDiff
   └────────────┬─────────────┘
                │ runs on the bridge
   ┌────────────▼─────────────┐
   │  Frames                    │  images / video
   └────────────┬─────────────┘
                │ scored (aesthetic / CLIP-to-intent / user)
   ┌────────────▼─────────────┐
   │  Evolve                    │  explore param space, keep winners, mutate,
   │  (search toward intent)    │  nudge the orbs — loop closes
   └──────────────────────────┘
```

## Orb-as-agent model
Each orb already carries a value (weight → gradient + ring, v0.13). The vision extends an orb into
an **agent** with: a *binding* (which node param(s)/prompt fragment/LoRA/mask/camera channel it
drives), a *motion* (how it moves in 3D over time), and a *policy* (how it reacts to signals —
audio, feedback score, neighbor orbs). Motion and value are two views of the same state, so moving
an orb changes what it renders and vice-versa.

## Phases (each its own spec → build)
1. **Motion Engine** *(this release; foundation)* — orbs move in 3D over a timeline; placement +
   motion encode values; playback/scrub/interpolate; a parameter-binding model; render-plan
   *stub* for Phase 2. Self-contained and shippable.
2. **Keyframe → render** — author value curves on the timeline (or capture them from orb motion);
   interpolated per-frame values drive a real batch/video render (variations + AnimateDiff). The
   render-plan stub becomes real.
3. **Reactivity** — live signals (Web Audio analyser first) drive motion/values; orbs pulse and
   drift to sound; those reactions can be baked into a clip.
4. **Feedback + Auto-Evolve** *(agentic closed loop)* — score finished frames against a concrete
   objective (aesthetic predictor and/or CLIP-similarity to the prompt, plus explicit user
   quality goals), then run an explore→score→evolve search (bandit/evolutionary) that mutates the
   render program and nudges the orbs toward higher score. Orb *policies* become autonomous here.

## Invariants (hold across every phase)
- **Local-first & honest**: no silent fallbacks; anything not really rendered says so.
- **Editing never breaks**: the constellation stays a real editor (click-to-expand cards, wiring).
- **Two loops, cleanly separated**: the editor idles (dirty-flag) when static; a **continuous
  playback loop** runs only while motion is playing, and stops when paused/stopped.
- **No workflow-schema churn from motion**: motion lives in its own persisted slice; playback
  drives a *preview* overlay and only writes workflow params on an explicit Bake/Render.
- **Values are the source of truth**: motion is derived from / bakes to values, never a separate
  hidden state that can desync.

## Open research question (resolved in Phase 4, flagged now)
"Toward the user's intent" needs a concrete objective. Candidates: CLIP image-text similarity to
the prompt, a learned aesthetic score, prompt-adherence heuristics, or explicit user ratings —
likely a weighted blend with a small scorer model on the managed runtime. Phase 4 will pin this
down; Phases 1–3 do not depend on it.
