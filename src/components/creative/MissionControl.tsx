import { useMemo } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import { ReadinessRing } from './ReadinessRing';
import { NextActionCard } from './NextActionCard';
import { rankByUrgency, nextAction } from '../../core/creative/nextAction';
import { scanEntropy, summarizeEntropy } from '../../core/creative/entropy';
import { detectMissing } from '../../core/creative/missing';
import { collectProof } from '../../core/creative/proof';
import type { ProjectBrain } from '../../core/creative/types';
import '../../styles/creative.css';

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function MissionControl() {
  const brains = useStudio((s) => s.creative.brains);
  const gallery = useStudio((s) => s.gallery);
  const setView = useStudio((s) => s.setView);
  const openProject = useStudio((s) => s.openProject);
  const seedDemo = useStudio((s) => s.seedCreativeDemo);
  const seeded = useStudio((s) => s.creative.seeded);
  const analysisContext = useStudio((s) => s.analysisContext);
  const portfolioReport = useStudio((s) => s.portfolioReport);

  const ctx = analysisContext();
  const activeBrains = useMemo(() => brains.filter((b) => b.status !== 'archived'), [brains]);
  const ranked = useMemo(() => rankByUrgency(activeBrains, ctx), [activeBrains, ctx]);
  const entropy = useMemo(() => scanEntropy(brains, ctx, new Date()), [brains, ctx]);
  const entropySummary = summarizeEntropy(entropy);
  const proof = useMemo(() => {
    const ids = new Set(gallery.map((g) => g.id));
    return collectProof(brains, (id) => ids.has(id));
  }, [brains, gallery]);

  // The single most urgent action across all projects.
  const topProject: ProjectBrain | undefined = ranked[0]?.brain;
  const topAction = topProject ? nextAction(topProject, ctx) : null;

  // Aggregate missing pieces (top blockers first) across all projects.
  const aggregateMissing = useMemo(() => {
    const rows: { project: ProjectBrain; count: number; blockers: number }[] = [];
    for (const b of activeBrains) {
      const m = detectMissing(b, ctx);
      if (m.length) rows.push({ project: b, count: m.length, blockers: m.filter((x) => x.severity === 'blocker').length });
    }
    return rows.sort((a, b) => b.blockers - a.blockers || b.count - a.count);
  }, [activeBrains, ctx]);

  const recentSparks = useMemo(
    () => [...brains].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 4),
    [brains],
  );

  if (brains.length === 0) {
    return (
      <main className="studio-page creative-page mission-page scroll" aria-label="Mission Control">
        <div className="studio-page-inner">
          <section className="card creative-card mission-onboard">
            <span className="mission-onboard-glyph" aria-hidden="true">{Icon.compass({ size: 44 })}</span>
            <h1>Mission Control</h1>
            <p>LumenDeck now understands your work as living projects — with memory, readiness scores, missing pieces, and a next best action. Create a project, or load a demo that walks a chaotic project all the way to release-ready.</p>
            <div className="mission-onboard-actions">
              <button className="btn primary" type="button" onClick={() => setView('projects')}>{Icon.plus({ size: 15 })} New project</button>
              <button className="btn" type="button" onClick={seedDemo}>{Icon.sparkle({ size: 15 })} Load demo</button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="studio-page creative-page mission-page scroll" aria-label="Mission Control">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Mission Control</p>
            <h1>{Icon.compass({ size: 22 })} Command deck</h1>
            <p className="creative-lead">{activeBrains.length} active project{activeBrains.length === 1 ? '' : 's'} · {proof.exports} shipped export{proof.exports === 1 ? '' : 's'}</p>
          </div>
          {!seeded && brains.length < 2 ? <button className="btn" type="button" onClick={seedDemo}>{Icon.sparkle({ size: 14 })} Load demo</button> : null}
        </header>

        {topAction && topProject ? (
          <div className="mission-nba">
            <span className="mission-nba-for">For <b>{topProject.name}</b></span>
            <NextActionCard action={topAction} />
          </div>
        ) : null}

        {(() => {
          const portfolio = portfolioReport();
          return (
            <button type="button" className="card creative-card overview-teaser" onClick={() => setView('overview')}>
              <span className="overview-teaser-head">{Icon.target({ size: 15 })} Studio Overview</span>
              <span className="overview-teaser-body">
                {portfolio.top
                  ? <>Work on next: <b>{portfolio.top.name}</b> — {portfolio.top.action.title}</>
                  : 'Portfolio clear — nothing needs attention.'}
              </span>
              <span className="overview-teaser-meta">{portfolio.funnel.shipped}/{portfolio.funnel.total} shipped {Icon.play({ size: 12 })}</span>
            </button>
          );
        })()}

        <div className="mission-grid">
          <section className="card creative-card mission-radar">
            <div className="creative-card-head"><h3>{Icon.target({ size: 15 })} Launch radar</h3><span className="spacer" /><button className="btn tiny" type="button" onClick={() => setView('projects')}>Open</button></div>
            <ul className="radar-list">
              {ranked.map(({ brain, readiness, action }) => (
                <li key={brain.id}>
                  <button type="button" className="radar-row" onClick={() => openProject(brain.id)}>
                    <ReadinessRing score={readiness} size={40} />
                    <span className="radar-body">
                      <span className="radar-name">{brain.name} <span className={`chip status-${brain.status}`}>{brain.status.replace('-', ' ')}</span></span>
                      <span className="radar-action">{action.title}</span>
                    </span>
                    <span className="radar-go" aria-hidden="true">{Icon.play({ size: 13 })}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="card creative-card mission-missing">
            <div className="creative-card-head"><h3>{Icon.target({ size: 15 })} Missing pieces</h3></div>
            {aggregateMissing.length === 0 ? (
              <p className="creative-empty">Every active project is complete.</p>
            ) : (
              <ul className="mission-missing-list">
                {aggregateMissing.map(({ project, count, blockers }) => (
                  <li key={project.id}>
                    <button type="button" onClick={() => openProject(project.id)}>
                      <span className="mm-name">{project.name}</span>
                      <span className="mm-counts">
                        {blockers ? <span className="chip sev-blocker">{blockers} blocker{blockers === 1 ? '' : 's'}</span> : null}
                        <span className="chip">{count} missing</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card creative-card mission-entropy">
            <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} Entropy</h3><span className="spacer" /><button className="btn tiny" type="button" onClick={() => setView('entropy')}>Open</button></div>
            <div className="entropy-summary compact">
              <span className="entropy-stat high"><b>{entropySummary.high}</b> high</span>
              <span className="entropy-stat medium"><b>{entropySummary.medium}</b> med</span>
              <span className="entropy-stat low"><b>{entropySummary.low}</b> low</span>
            </div>
            <ul className="mission-entropy-list">
              {entropy.slice(0, 4).map((e) => <li key={e.id} className={`sev-${e.severity}`}><span className="entropy-sev" aria-hidden="true" />{e.label}</li>)}
              {entropy.length === 0 ? <p className="creative-empty">No disorder detected.</p> : null}
            </ul>
          </section>

          <section className="card creative-card mission-proof">
            <div className="creative-card-head"><h3>{Icon.trophy({ size: 15 })} Proof</h3><span className="spacer" /><button className="btn tiny" type="button" onClick={() => setView('proof')}>Open</button></div>
            {proof.artifacts.length === 0 ? (
              <p className="creative-empty">Nothing shipped yet.</p>
            ) : (
              <ul className="mission-proof-list">
                {proof.artifacts.slice(0, 5).map((a) => (
                  <li key={a.id}><span className="mp-kind" aria-hidden="true">{Icon.ok({ size: 12 })}</span><span className="mp-label">{a.label}</span><span className="mp-proj">{a.projectName}</span></li>
                ))}
              </ul>
            )}
          </section>

          <section className="card creative-card mission-sparks">
            <div className="creative-card-head"><h3>{Icon.sparkle({ size: 15 })} Recent sparks</h3></div>
            <ul className="mission-sparks-list">
              {recentSparks.map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => openProject(b.id)}>
                    <span className="spark-name">{b.name}</span>
                    <span className="spark-meta">{b.events[b.events.length - 1]?.label ?? 'updated'} · {timeAgo(b.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
