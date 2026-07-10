import { useMemo } from 'react';
import { useStudio } from '../../state/store';
import { analyzePortfolio } from '../../core/creative/portfolio';
import { buildAnalysisContext } from '../../state/creative';
import { Icon } from '../icons';
import { ReadinessRing } from './ReadinessRing';
import type { ProjectStatus } from '../../core/creative/types';
import '../../styles/creative.css';

const STATUS_ORDER: ProjectStatus[] = [
  'spark',
  'in-progress',
  'polishing',
  'release-ready',
  'shipped',
  'archived',
];

export function StudioOverview() {
  // Subscribe to the reactive slices (so the view re-renders when projects change —
  // e.g. the empty-state "Load demo" must repopulate it) and derive the report with
  // useMemo. NOTE: never `useStudio((s) => s.portfolioReport())` — calling the getter
  // inside the selector returns a fresh object each render → Zustand's "getSnapshot
  // should be cached" infinite-loop crash.
  const brains = useStudio((s) => s.creative.brains);
  const recipes = useStudio((s) => s.creative.recipes);
  const gallery = useStudio((s) => s.gallery);
  const shelf = useStudio((s) => s.shelf);
  const setView = useStudio((s) => s.setView);
  const setActiveProject = useStudio((s) => s.setActiveProject);
  const openProject = useStudio((s) => s.openProject);
  const seedDemo = useStudio((s) => s.seedCreativeDemo);
  const report = useMemo(
    () => analyzePortfolio(brains, recipes, buildAnalysisContext(gallery, brains, shelf), new Date()),
    [brains, recipes, gallery, shelf],
  );

  const { triage, top, funnel, stall, stale, strengths, velocity } = report;

  if (funnel.total === 0) {
    return (
      <main className="studio-page creative-page scroll" aria-label="Studio Overview">
        <div className="studio-page-inner">
          <section className="card creative-card mission-onboard">
            <span className="mission-onboard-glyph" aria-hidden="true">{Icon.target({ size: 44 })}</span>
            <h1>Studio Overview</h1>
            <p>Once you have a few projects, this is your command deck across all of them — which project to work on next, where projects stall, and what you ship. Create a project or load a demo to see it come alive.</p>
            <div className="mission-onboard-actions">
              <button className="btn primary" type="button" onClick={() => setView('projects')}>{Icon.plus({ size: 15 })} New project</button>
              <button className="btn" type="button" onClick={seedDemo}>{Icon.sparkle({ size: 15 })} Load demo</button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const workOnTop = () => {
    if (!top) return;
    setActiveProject(top.brainId);
    setView(top.action.targetView);
  };
  // Only projects that actually need attention (attention > 0 excludes shipped/
  // archived, which the engine keeps in triage at score 0) and not the hero.
  const rest = triage.filter((t) => t.attention > 0 && t.brainId !== top?.brainId);
  const maxVelocity = Math.max(1, ...velocity.weeks.map((w) => Math.max(w.started, w.shipped)));

  return (
    <main className="studio-page creative-page scroll" aria-label="Studio Overview">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Studio Overview</p>
            <h1>{Icon.target({ size: 22 })} Portfolio deck</h1>
            <p className="creative-lead">
              {funnel.total} project{funnel.total === 1 ? '' : 's'} · {funnel.shipped} shipped · {Math.round(funnel.shipRate * 100)}% ship rate
            </p>
            <button className="btn tiny" type="button" onClick={() => setView('craft')}>{Icon.sparkle({ size: 13 })} Craft insights</button>
          </div>
        </header>

        {/* Triage hero: the single project to work on next */}
        {top ? (
          <section className="card creative-card overview-triage">
            <div className="overview-triage-main">
              <ReadinessRing score={top.readiness} size={56} />
              <div className="overview-triage-body">
                <span className="overview-triage-kicker">Work on this next</span>
                <h2>{top.name} <span className={`chip status-${top.status}`}>{top.status.replace('-', ' ')}</span></h2>
                <p className="overview-triage-action"><b>{top.action.title}</b> — {top.action.reason}</p>
              </div>
            </div>
            <button className="btn primary" type="button" onClick={workOnTop}>{Icon.play({ size: 14 })} Work on this</button>
          </section>
        ) : (
          <section className="card creative-card overview-clear">
            {Icon.ok({ size: 18 })} Portfolio clear — every active project is shipped or waiting.
          </section>
        )}

        <div className="mission-grid">
          {/* Attention queue */}
          {rest.length > 0 ? (
            <section className="card creative-card">
              <div className="creative-card-head"><h3>{Icon.target({ size: 15 })} Attention queue</h3><span className="spacer" /><button className="btn tiny" type="button" onClick={() => setView('projects')}>Projects</button></div>
              <ul className="radar-list">
                {rest.map((t) => (
                  <li key={t.brainId}>
                    <button type="button" className="radar-row" onClick={() => openProject(t.brainId)}>
                      <ReadinessRing score={t.readiness} size={40} />
                      <span className="radar-body">
                        <span className="radar-name">{t.name} <span className={`chip status-${t.status}`}>{t.status.replace('-', ' ')}</span></span>
                        <span className="radar-action">{t.action.title}</span>
                      </span>
                      <span className="radar-go" aria-hidden="true">{Icon.play({ size: 13 })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Funnel */}
          <section className="card creative-card">
            <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} Finish funnel</h3></div>
            <ul className="overview-funnel">
              {STATUS_ORDER.map((s) => {
                const count = funnel.byStatus[s];
                const pct = funnel.total > 0 ? Math.round((count / funnel.total) * 100) : 0;
                return (
                  <li key={s}>
                    <span className={`overview-funnel-label chip status-${s}`}>{s.replace('-', ' ')}</span>
                    <span className="overview-funnel-bar"><span className={`overview-funnel-fill status-${s}`} style={{ width: `${pct}%` }} /></span>
                    <span className="overview-funnel-count">{count}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* What stalls you */}
          <section className="card creative-card">
            <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} What stalls you</h3></div>
            {stall ? (
              <div className="overview-stall">
                <p className="overview-stall-dim">{stall.label}</p>
                <p className="overview-stall-detail">Weakest dimension across {stall.affected} unshipped project{stall.affected === 1 ? '' : 's'} — avg {stall.avgScore}/100.</p>
              </div>
            ) : (
              <p className="creative-empty">No unshipped projects to analyze.</p>
            )}
          </section>

          {/* Stale */}
          <section className="card creative-card">
            <div className="creative-card-head"><h3>{Icon.target({ size: 15 })} Going stale</h3></div>
            {stale.length === 0 ? (
              <p className="creative-empty">Nothing has gone cold.</p>
            ) : (
              <ul className="mission-missing-list">
                {stale.map((s) => (
                  <li key={s.brainId}>
                    <button type="button" onClick={() => openProject(s.brainId)}>
                      <span className="mm-name">{s.name}</span>
                      <span className="mm-counts"><span className="chip">{s.daysSinceUpdate}d untouched</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Strengths */}
          <section className="card creative-card">
            <div className="creative-card-head"><h3>{Icon.trophy({ size: 15 })} Your strengths</h3></div>
            {strengths.topRecipes.length === 0 && !strengths.strongestType ? (
              <p className="creative-empty">Reuse recipes and ship projects to reveal your strengths.</p>
            ) : (
              <div className="overview-strengths">
                {strengths.strongestType ? (
                  <p className="overview-strength-type">Best-finishing type: <b>{strengths.strongestType.type}</b> ({strengths.strongestType.shipped}/{strengths.strongestType.total} shipped)</p>
                ) : null}
                {strengths.topRecipes.length > 0 ? (
                  <div className="overview-recipe-chips">
                    {strengths.topRecipes.map((r) => (
                      <span key={r.id} className="chip">{r.name} <b>×{r.uses}</b></span>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          {/* Velocity */}
          <section className="card creative-card">
            <div className="creative-card-head"><h3>{Icon.sparkle({ size: 15 })} Velocity (8 weeks)</h3></div>
            <div className="overview-velocity" role="img" aria-label="Started vs shipped over the last 8 weeks">
              {velocity.weeks.map((w, i) => (
                <span key={i} className="overview-velocity-col" title={`${w.label}: ${w.started} started, ${w.shipped} shipped`}>
                  <span className="overview-velocity-bars">
                    <span className="overview-velocity-started" style={{ height: `${(w.started / maxVelocity) * 100}%` }} />
                    <span className="overview-velocity-shipped" style={{ height: `${(w.shipped / maxVelocity) * 100}%` }} />
                  </span>
                  <span className="overview-velocity-label">{w.label}</span>
                </span>
              ))}
            </div>
            <div className="overview-velocity-legend"><span className="ov-dot started" /> started <span className="ov-dot shipped" /> shipped</div>
          </section>
        </div>
      </div>
    </main>
  );
}
