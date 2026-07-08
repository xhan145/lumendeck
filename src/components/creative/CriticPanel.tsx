import { useMemo } from 'react';
import { Icon } from '../icons';
import { ReadinessRing } from './ReadinessRing';
import { NextActionCard } from './NextActionCard';
import { critiqueProject } from '../../core/creative/critic';
import type { AnalysisContext } from '../../core/creative/context';
import type { ProjectBrain } from '../../core/creative/types';

const DIM_LABELS: [keyof ReturnType<typeof critiqueProject>['dimensions'], string][] = [
  ['visualConsistency', 'Visual consistency'],
  ['assetCompleteness', 'Asset completeness'],
  ['promptQuality', 'Prompt quality'],
  ['exportReadiness', 'Export readiness'],
  ['fileHygiene', 'File hygiene'],
  ['launchReadiness', 'Launch readiness'],
  ['reusePotential', 'Reuse potential'],
];

function Bar({ label, value }: { label: string; value: number }) {
  const hue = value >= 75 ? 'var(--md-success)' : value >= 45 ? 'var(--md-secondary)' : 'var(--md-error)';
  return (
    <div className="critic-bar">
      <span className="critic-bar-label">{label}</span>
      <span className="critic-bar-track"><span className="critic-bar-fill" style={{ width: `${value}%`, background: hue }} /></span>
      <span className="critic-bar-num">{value}</span>
    </div>
  );
}

function List({ title, icon, items, tone }: { title: string; icon: React.ReactNode; items: string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <div className={`critic-list ${tone}`}>
      <h4>{icon} {title}</h4>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

/** The Redteam project critic panel: strengths, weaknesses, risks, fixes, next action. */
export function CriticPanel({ brain, ctx }: { brain: ProjectBrain; ctx: AnalysisContext }) {
  const report = useMemo(() => critiqueProject(brain, ctx, new Date()), [brain, ctx]);
  return (
    <section className="card creative-card critic-panel" aria-label="Project critique">
      <div className="creative-card-head">
        <h3>{Icon.pulse({ size: 15 })} Redteam critique</h3>
        <span className="spacer" />
        <span className="chip local-chip" title="Computed locally from your project metadata — no cloud calls">Local · no AI</span>
      </div>
      <div className="critic-top">
        <ReadinessRing score={report.readiness} size={76} label="ready" />
        <div className="critic-dims">
          {DIM_LABELS.map(([key, label]) => <Bar key={key} label={label} value={report.dimensions[key]} />)}
        </div>
      </div>
      <div className="critic-lists">
        <List title="Strengths" icon={Icon.ok({ size: 14 })} items={report.strengths} tone="good" />
        <List title="Weaknesses" icon={Icon.warning({ size: 14 })} items={report.weaknesses} tone="warn" />
        <List title="Risks" icon={Icon.error({ size: 14 })} items={report.risks} tone="risk" />
        <List title="Recommended fixes" icon={Icon.wrench({ size: 14 })} items={report.fixes} tone="fix" />
      </div>
      <NextActionCard action={report.nextAction} compact />
    </section>
  );
}
