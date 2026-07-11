import { useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import { analyzeCraft, MIN_CORPUS, MIN_KEPT } from '../../core/creative/craftBrain';
import { buildAnalysisContext } from '../../state/creative';
import { Icon } from '../icons';
import '../../styles/creative.css';

function Bars({ title, items }: { title: string; items: { label: string; count: number }[] }) {
  if (items.length === 0) return null;
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="craft-dim">
      <span className="craft-dim-title">{title}</span>
      <ul className="craft-bars">
        {items.map((i) => (
          <li key={i.label}>
            <span className="craft-bar-label">{i.label}</span>
            <span className="craft-bar-track"><span className="craft-bar-fill" style={{ width: `${(i.count / max) * 100}%` }} /></span>
            <span className="craft-bar-count">{i.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CraftInsights() {
  const gallery = useStudio((s) => s.gallery);
  const brains = useStudio((s) => s.creative.brains);
  const recipes = useStudio((s) => s.creative.recipes);
  const shelf = useStudio((s) => s.shelf);
  const promoteToRecipe = useStudio((s) => s.promoteToRecipe);
  const setView = useStudio((s) => s.setView);
  const [made, setMade] = useState<string[]>([]);

  const report = useMemo(
    () => analyzeCraft(buildAnalysisContext(gallery, brains, shelf).renders, recipes, new Date()),
    [gallery, brains, shelf, recipes],
  );

  const maxChip = Math.max(1, ...report.palette.map((p) => p.count));
  const suggestions = report.suggestions.filter((s) => !made.includes(s.promptText));

  const make = (promptText: string) => {
    promoteToRecipe({ text: promptText, name: `Craft: ${promptText.slice(0, 32)}` });
    setMade((m) => [...m, promptText]);
  };

  return (
    <main className="studio-page creative-page scroll" aria-label="Craft insights">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Craft insights</p>
            <h1>{Icon.sparkle({ size: 22 })} What&apos;s working in your craft</h1>
            <p className="creative-lead">
              Mined from {report.totals.corpus} render{report.totals.corpus === 1 ? '' : 's'} · {report.totals.kept} kept (linked/tagged).
            </p>
          </div>
        </header>

        {report.palette.length === 0 ? (
          <section className="card creative-card"><p className="creative-empty">No real renders yet — generate a few and this fills in.</p></section>
        ) : (
          <>
            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.sparkle({ size: 15 })} Signature palette</h3></div>
              <div className="craft-palette">
                {report.palette.map((p) => (
                  <span key={p.label} className="craft-chip" style={{ fontSize: `${0.8 + (p.count / maxChip) * 0.7}rem`, opacity: 0.55 + (p.count / maxChip) * 0.45 }}>{p.label}</span>
                ))}
              </div>
            </section>

            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} Favored settings</h3></div>
              <div className="craft-dims">
                <Bars title="Model" items={report.settings.model} />
                <Bars title="Sampler" items={report.settings.sampler} />
                <Bars title="CFG" items={report.settings.cfg} />
                <Bars title="Steps" items={report.settings.steps} />
                <Bars title="Aspect" items={report.settings.aspect} />
              </div>
            </section>

            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.trophy({ size: 15 })} What&apos;s working</h3></div>
              {report.ready && report.working.length > 0 ? (
                <>
                  <p className="craft-note">Correlates with the renders you kept — a signal, not proof.</p>
                  <ul className="craft-working">
                    {report.working.map((w) => (
                      <li key={`${w.kind}:${w.label}`}>
                        <span className="craft-work-label">{w.label}</span>
                        <span className={`chip craft-conf ${w.confidence}`}>{w.confidence}</span>
                        <span className="craft-work-lift">{w.lift}× lift</span>
                        <span className="craft-work-counts">in {w.keptCount} of {w.allCount}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : report.ready ? (
                <p className="creative-empty">
                  Nothing stands out yet — your kept renders track your overall style rather than any single token or setting.
                </p>
              ) : (
                <p className="creative-empty">
                  Not enough signal yet — keep creating and curating (link renders to projects, tag them). Insights unlock at ~{MIN_CORPUS} renders / {MIN_KEPT} kept.
                </p>
              )}
            </section>

            {report.ready && suggestions.length > 0 ? (
              <section className="card creative-card">
                <div className="creative-card-head"><h3>{Icon.beaker({ size: 15 })} Suggested recipes</h3></div>
                <div className="craft-suggestions">
                  {suggestions.map((s) => (
                    <div key={s.promptText} className="craft-suggestion">
                      <span className="craft-suggestion-text">{s.promptText}</span>
                      <span className="craft-suggestion-meta">seen in {s.keptCount} kept</span>
                      <button className="btn tiny" type="button" onClick={() => make(s.promptText)}>Make recipe</button>
                    </div>
                  ))}
                </div>
                <button className="btn tiny" type="button" onClick={() => setView('recipes')}>View recipes</button>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
