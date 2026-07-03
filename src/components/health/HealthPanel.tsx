import { useStudio } from '../../state/store';
import { Icon } from '../icons';

/** Pre-flight graph health. Clicking an issue selects the offending capsule. */
export function HealthPanel() {
  const health = useStudio((s) => s.health);
  const selectNode = useStudio((s) => s.selectNode);
  const setView = useStudio((s) => s.setView);

  const errors = health.filter((i) => i.severity === 'error').length;
  const warnings = health.length - errors;

  return (
    <section className="rail-section">
      <h3>
        {Icon.pulse({ size: 14 })} Graph Health
        {health.length > 0 ? <span className="chip" style={{ marginLeft: 'auto' }}>{errors} err · {warnings} warn</span> : null}
      </h3>
      {health.length === 0 ? (
        <div className="health-empty">{Icon.ok()} All checks pass — ready to render.</div>
      ) : (
        <div className="health-list">
          {health.map((issue) => (
            <button
              key={issue.id}
              type="button"
              className={`health-item ${issue.severity}`}
              onClick={() => { if (issue.nodeId) { selectNode(issue.nodeId); setView('graph'); } }}
              title={issue.nodeId ? 'Show capsule in Graph View' : issue.message}
            >
              {issue.severity === 'error' ? Icon.error({ size: 15 }) : Icon.warning({ size: 15 })}
              <span>{issue.message}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
