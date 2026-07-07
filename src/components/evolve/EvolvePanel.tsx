import { useMemo } from 'react';
import { useStudio, EVOLVE_POP_MIN, EVOLVE_POP_MAX, EVOLVE_GEN_MIN, EVOLVE_GEN_MAX } from '../../state/store';
import { renormalizeWeights } from '../../core/evolve/genome';
import { Icon } from '../icons';
import '../../styles/evolve.css';

/**
 * Auto-Evolve panel — the explore→score→evolve control surface (Living
 * Constellation Phase 4). Objective weight sliders (CLIP / aesthetic), population
 * + generations, an Auto/Interactive toggle, Run, a per-generation grid of scored
 * candidate thumbnails (best framed), Interactive parent-picking, and "Adopt best".
 * Lives in the graph/motion dock beside the Motion Timeline + Audio panels.
 *
 * HONEST FRAMING: the objective is a real blend — CLIP prompt-adherence +
 * deterministic aesthetic heuristics, computed in the bridge scorer — NOT a
 * learned taste model. When CLIP can't load, a LOUD banner says the score is
 * aesthetics-only (its weight zeroed), never a fabricated CLIP number. Runs need
 * the local Diffusers bridge; Mock/ComfyUI disable Run with a tooltip.
 *
 * Reduced-motion: nothing auto-runs; Run is always an explicit press, and CSS
 * suppresses the score-bar/progress transitions under prefers-reduced-motion.
 */
export function EvolvePanel() {
  const evolve = useStudio((s) => s.evolve);
  const adapterId = useStudio((s) => s.adapterId);
  const bridgeOnline = useStudio((s) => s.bridgeOnline);

  const setEvolveConfig = useStudio((s) => s.setEvolveConfig);
  const runEvolve = useStudio((s) => s.runEvolve);
  const pickEvolveParent = useStudio((s) => s.pickEvolveParent);
  const evolveNextGeneration = useStudio((s) => s.evolveNextGeneration);
  const adoptBest = useStudio((s) => s.adoptBest);
  const clearEvolve = useStudio((s) => s.clearEvolve);

  const { mode, weights, population, generations, running, clipAvailable, fallbackReason } = evolve;

  // Run needs an ONLINE local Diffusers bridge (Mock only makes procedural
  // placeholders; ComfyUI has no scorer). Mirror the Motion panel's honest gate.
  const canRun = adapterId === 'bridge' && bridgeOnline;
  const runDisabledReason = useMemo(() => {
    if (adapterId === 'mock') return 'Switch to the local Diffusers bridge to evolve — the Mock backend only makes procedural placeholders with no real objective.';
    if (adapterId === 'comfyui') return 'Auto-Evolve needs the local Diffusers bridge (ComfyUI has no CLIP/aesthetic scorer).';
    if (!bridgeOnline) return 'The local bridge is offline. Start it (Settings → Backend) to evolve.';
    return '';
  }, [adapterId, bridgeOnline]);

  // Normalized display of the objective mix (what actually weights the score).
  const norm = useMemo(() => renormalizeWeights(weights, clipAvailable), [weights, clipAvailable]);

  const hasRun = evolve.generationsData.length > 0;
  const canAdopt = !!evolve.best && !running;
  const pct = Math.round(evolve.progress * 100);

  return (
    <section className="evolve-panel" aria-label="Auto-Evolve">
      <header className="ev-head">
        <h3 className="ev-title">{Icon.bolt({ size: 14 })} Auto-Evolve</h3>
        <span className={`ev-status ${running ? 'live' : ''}`} role="status" aria-live="polite">
          {running ? (evolve.status ?? 'Running…') : hasRun ? `${evolve.generationsData.length}/${generations} gens` : 'Idle'}
        </span>
      </header>

      <p className="field-help ev-note">
        Objective = CLIP prompt-adherence + aesthetic heuristics, scored in the bridge. Explore → score → breed. Curated search, not a learned taste model.
      </p>

      {/* ---- CLIP-unavailable loud banner --------------------------------- */}
      {hasRun && !clipAvailable ? (
        <p className="ev-clip-banner" role="alert">
          {Icon.warning({ size: 14 })} CLIP unavailable — scoring on aesthetics only (CLIP weight zeroed).
          {fallbackReason ? ` ${fallbackReason}` : ''}
        </p>
      ) : null}

      {/* ---- objective weights -------------------------------------------- */}
      <div className="ev-weights" role="group" aria-label="Objective weights">
        <label className="ev-inline">
          <span className="ev-inline-label">CLIP</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={weights.clip}
            disabled={running}
            aria-label="CLIP objective weight"
            onChange={(e) => setEvolveConfig({ weights: { clip: Number(e.target.value) } })}
          />
          <span className="ev-inline-val mono">{Math.round(norm.clip * 100)}%</span>
        </label>
        <label className="ev-inline">
          <span className="ev-inline-label">Aesthetic</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={weights.aesthetic}
            disabled={running}
            aria-label="Aesthetic objective weight"
            onChange={(e) => setEvolveConfig({ weights: { aesthetic: Number(e.target.value) } })}
          />
          <span className="ev-inline-val mono">{Math.round(norm.aesthetic * 100)}%</span>
        </label>
      </div>

      {/* ---- population / generations / mode ------------------------------ */}
      <div className="ev-config" role="group" aria-label="Search settings">
        <label className="ev-inline">
          <span className="ev-inline-label">Population</span>
          <input
            type="number"
            min={EVOLVE_POP_MIN}
            max={EVOLVE_POP_MAX}
            step={1}
            value={population}
            disabled={running}
            aria-label="Population size per generation"
            onChange={(e) => setEvolveConfig({ population: Number(e.target.value) })}
          />
        </label>
        <label className="ev-inline">
          <span className="ev-inline-label">Generations</span>
          <input
            type="number"
            min={EVOLVE_GEN_MIN}
            max={EVOLVE_GEN_MAX}
            step={1}
            value={generations}
            disabled={running}
            aria-label="Number of generations"
            onChange={(e) => setEvolveConfig({ generations: Number(e.target.value) })}
          />
        </label>
        <div className="ev-mode" role="group" aria-label="Mode">
          <button
            type="button"
            className={`btn ev-mode-btn ${mode === 'auto' ? 'active' : ''}`}
            aria-pressed={mode === 'auto'}
            disabled={running}
            title="Auto: run all generations, the bridge scores + selects."
            onClick={() => setEvolveConfig({ mode: 'auto' })}
          >
            Auto
          </button>
          <button
            type="button"
            className={`btn ev-mode-btn ${mode === 'interactive' ? 'active' : ''}`}
            aria-pressed={mode === 'interactive'}
            disabled={running}
            title="Interactive: score one generation, you pick the parents for the next."
            onClick={() => setEvolveConfig({ mode: 'interactive' })}
          >
            Interactive
          </button>
        </div>
      </div>

      {/* ---- run / adopt / clear ------------------------------------------ */}
      <div className="ev-actions" role="group" aria-label="Run controls">
        <button
          className="btn primary ev-run"
          type="button"
          disabled={running || !canRun}
          aria-disabled={running || !canRun}
          title={canRun ? 'Render + score a generation of candidates' : runDisabledReason}
          onClick={() => void runEvolve()}
        >
          {Icon.bolt({ size: 14 })} {running ? 'Evolving…' : 'Run evolve'}
        </button>
        <button
          className="btn ev-adopt"
          type="button"
          disabled={!canAdopt}
          aria-disabled={!canAdopt}
          title={canAdopt ? 'Write the best genome into the workflow + save its image to the Gallery' : 'Run an evolve first, then adopt the best.'}
          onClick={() => void adoptBest()}
        >
          {Icon.ok({ size: 14 })} Adopt best
        </button>
        <button
          className="btn icon ev-clear"
          type="button"
          disabled={running || !hasRun}
          aria-label="Clear evolve results"
          title="Clear the current run (keeps your settings)"
          onClick={() => clearEvolve()}
        >
          {Icon.trash({ size: 14 })}
        </button>
      </div>

      {!canRun ? (
        <p className="field-help ev-gate">{runDisabledReason}</p>
      ) : null}

      {/* ---- progress ----------------------------------------------------- */}
      {running ? (
        <div className="ev-progress">
          <div
            className="ev-progress-bar"
            role="progressbar"
            aria-label="Generation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className="ev-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="ev-progress-status mono" role="status" aria-live="polite">
            {evolve.status ? `${evolve.status} · ` : ''}{pct}%
          </span>
        </div>
      ) : null}

      {evolve.error ? (
        <p className="ev-error" role="alert">{Icon.warning({ size: 14 })} {evolve.error}</p>
      ) : null}

      {/* ---- generations grid --------------------------------------------- */}
      {hasRun ? (
        <div className="ev-generations">
          {evolve.generationsData.map((gen, gi) => {
            const isLast = gi === evolve.generationsData.length - 1;
            const pickable = mode === 'interactive' && evolve.awaitingParents && isLast && !running;
            return (
              <div key={gi} className="ev-gen" aria-label={`Generation ${gi + 1}`}>
                <div className="ev-gen-label">Gen {gi + 1}</div>
                <ul className="ev-cands">
                  {gen.candidates.map((c) => {
                    const isBest = !!evolve.best && evolve.best.generation === gi && evolve.best.genomeIndex === c.genomeIndex;
                    const selected = pickable && evolve.selectedParents.includes(c.genomeIndex);
                    const scorePct = Math.round(Math.max(0, Math.min(1, c.score)) * 100);
                    const clipLabel = c.breakdown.clip == null ? 'CLIP n/a' : `CLIP ${c.breakdown.clip.toFixed(2)}`;
                    const title = `Score ${c.score.toFixed(3)} · ${clipLabel} · Aesthetic ${c.breakdown.aesthetic.toFixed(2)}`;
                    const cls = `ev-cand${isBest ? ' best' : ''}${selected ? ' selected' : ''}${pickable ? ' pickable' : ''}`;
                    const thumb = (
                      <>
                        <img className="ev-cand-img" src={c.dataUrl} alt={`Candidate ${c.genomeIndex + 1}, score ${c.score.toFixed(2)}`} />
                        {isBest ? <span className="ev-cand-badge" aria-hidden="true">{Icon.ok({ size: 12 })}</span> : null}
                        <div className="ev-cand-score" title={title}>
                          <div className="ev-cand-score-bar"><div className="ev-cand-score-fill" style={{ width: `${scorePct}%` }} /></div>
                          <span className="ev-cand-score-val mono">{c.score.toFixed(2)}</span>
                        </div>
                      </>
                    );
                    return (
                      <li key={c.genomeIndex} className={cls}>
                        {pickable ? (
                          <button
                            type="button"
                            className="ev-cand-pick"
                            aria-pressed={selected}
                            title={`${title} — click to ${selected ? 'unpick' : 'pick'} as a parent`}
                            onClick={() => pickEvolveParent(c.genomeIndex)}
                          >
                            {thumb}
                          </button>
                        ) : (
                          <div className="ev-cand-static" title={title}>{thumb}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {mode === 'interactive' && evolve.awaitingParents && !running ? (
            <button
              className="btn primary ev-next"
              type="button"
              title={evolve.selectedParents.length > 0 ? 'Breed the next generation from your picks' : 'Breed the next generation from the top candidates'}
              onClick={() => void evolveNextGeneration()}
            >
              {Icon.play({ size: 14 })} Next generation{evolve.selectedParents.length > 0 ? ` (${evolve.selectedParents.length} picked)` : ''}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
