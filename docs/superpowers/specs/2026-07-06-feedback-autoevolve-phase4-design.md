# LumenDeck — Feedback + Auto-Evolve (Living Constellation Phase 4, 2026-07-06)

Close the loop: render candidate variants, **score** each against a concrete objective, and run an
**explore→score→evolve** search that mutates the render program toward higher score — the
"self-evolving render brain." Realizes vision-doc Phase 4 and pins its open objective question.

## The objective — pinned HONESTLY (no fabricated "learned taste")
Score(image, prompt) = weighted blend, weights user-set in the UI:
- **CLIP similarity** (real): transformers `CLIPModel`/`CLIPProcessor` (already on the managed
  runtime) — cosine similarity of image vs prompt embeddings. This is genuine prompt-adherence, not
  a made-up model.
- **Aesthetic heuristics** (real, deterministic, numpy): sharpness (variance of Laplacian),
  contrast (luma std), colorfulness (Hasler-Süsstrunk), entropy. Normalized + blended.
- **User rating** (optional, interactive): the user can pick the winner each generation — the
  always-available honest path that needs no model.

If CLIP can't load, the loop runs on **heuristics + user pick only**, labeled loudly (never a fake
CLIP number). Weights that reference an unavailable signal are zeroed with a notice.

## Search — bridge, model resident across the whole run
`POST /evolve` body `{ base: RenderJob, prompt, knobs, weights, population, generations, mode }`:
- **Genome**: a vector over mutable knobs (cfg, steps, denoise, seed, and field position when a
  ghost/field drives the node) each with declared bounds; `mutate(genome, rate, rng)` and
  `crossover(a, b, rng)` are **pure** (`src/core/evolve/genome.ts`, mirrored minimally where the
  worker needs it via the job list — the bridge just renders the jobs the frontend sends per gen).
- **Loop**: for each generation, render the population (persistent worker, model loaded once),
  score each (scorer.py), select top-K by score, breed the next generation (elitism + mutated
  crossovers). Bounded: population 2..8, generations 1..6 (clamped server-side), one render's VRAM
  peak (frames rendered one at a time). Per-candidate progress via the progress file.
- Returns every generation's candidates `{ image_base64, score, breakdown{clip,aesthetic}, genome }`
  + the overall best. Loud error, never a silent placeholder.

## Two orchestration modes
- **Auto**: the bridge scores + selects; the loop runs to `generations` and returns the best.
- **Interactive** (the honest, model-free path): the bridge renders + scores ONE generation and
  returns it; the user picks the parent(s) in the UI; the frontend requests the next generation
  bred from the picks. No objective model required.

## Bridge files
- `bridge/scorer.py`: `score_images(images, prompt, weights)` — CLIP (cached model, lazy) +
  aesthetic metrics; returns per-image `{score, clip, aesthetic}`; degrades to heuristics-only if
  CLIP import/download fails (flagged in the result).
- `bridge/diffusers_backend.py`: `evolve_generation(jobs, prompt, weights)` — render the population
  via the resident worker (reuse `_render_one_image`), then `scorer.score_images`. Worker op
  `score`/reuse `render_sequence` frames + a `score` op, or a combined `evolve_step`.
- `server.py`: `POST /evolve` (auto: loop N generations) and `POST /evolve-step` (interactive: one
  generation, caller supplies the population jobs). Reuse `_resolve_render_targets`, `_JOB_ID`,
  progress. `'/evolve'` + `'/evolve-step'` added to API_PREFIXES.

## Frontend
- `src/core/evolve/genome.ts` (pure): knob descriptors + bounds, `randomGenome`, `mutate`,
  `crossover`, `genomeToPatches(genome) -> MotionParamPatch[]`, `patchesToJob(base, patches)`
  (reuse applyField/applyPatches + buildRenderJob).
- `src/bridge/httpAdapter.ts`: `evolve(...)` / `evolveStep(...)` posting the population jobs, polling
  progress, mapping results.
- **Evolve panel**: objective weight sliders (CLIP / aesthetic), population + generations, Auto vs
  Interactive toggle, Run; a generation grid of candidate thumbnails with score bars (best framed);
  in Interactive mode, click to pick parents → Next generation; "Adopt best" writes the winning
  genome's params into the workflow (one commit); candidates also land in the Gallery. Honest banner
  when CLIP is unavailable.
- Manifest for an adopted result records `{ evolve: { generations, population, weights, score } }`.

## Testing & verification
- **Pure vitest**: genome `mutate`/`crossover` (bounds respected, determinism via seeded rng),
  `genomeToPatches`, selection (top-K by score), weight normalization incl. zeroed-unavailable.
- **Bridge pytest**: `/evolve`/`/evolve-step` route shapes; `score_images` blend math + CLIP-absent
  degradation (mock CLIP); population/generation clamps; loud error path.
- **GPU (sd-turbo)**: a tiny run (population 4, generations 2) → candidates render, CLIP scores
  computed and **vary across candidates**, best-by-score selected, "adopt" writes params;
  interactive one-step returns a scored generation. Confirm the model loads once for the whole run.
- All existing tests green; tsc clean; MSI builds + verifies (watch sidecar size — cv2/CLIP imports
  must stay lazy/in-worker so PyInstaller doesn't bundle them; the v0.15 excludes cover this).

## Acceptance
1. Run Auto evolve on the demo prompt → generations of scored candidates, best highlighted; adopt
   writes its params and the image lands in the Gallery.
2. CLIP contributes a real prompt-adherence score; with CLIP off, the loop still runs on aesthetics
   + user pick, loudly labeled.
3. Interactive mode: pick a parent → next generation is bred from it.
4. Bounded + resident model; no silent placeholders; 399+ tests green; tsc clean; MSI ~sane size.
