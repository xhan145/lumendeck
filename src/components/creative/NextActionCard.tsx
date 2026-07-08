import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import type { NextAction } from '../../core/creative/types';

const ICON: Record<NextAction['targetView'], (p?: { size?: number }) => React.ReactNode> = {
  mission: Icon.compass,
  projects: Icon.layers,
  recipes: Icon.beaker,
  graph: Icon.graph,
  gallery: Icon.image,
  entropy: Icon.scatter,
  proof: Icon.trophy,
};

/** The single most important thing to do next — shown prominently. */
export function NextActionCard({ action, compact }: { action: NextAction; compact?: boolean }) {
  const setView = useStudio((s) => s.setView);
  return (
    <button
      type="button"
      className={`next-action ${compact ? 'compact' : ''}`}
      onClick={() => setView(action.targetView)}
      aria-label={`Next best action: ${action.title}`}
    >
      <span className="next-action-glyph" aria-hidden="true">{(ICON[action.targetView] ?? Icon.bolt)({ size: compact ? 18 : 22 })}</span>
      <span className="next-action-body">
        <span className="next-action-kicker">Next best action</span>
        <span className="next-action-title">{action.title}</span>
        {!compact ? <span className="next-action-reason">{action.reason}</span> : null}
      </span>
      <span className="next-action-go" aria-hidden="true">{Icon.play({ size: 14 })}</span>
    </button>
  );
}
