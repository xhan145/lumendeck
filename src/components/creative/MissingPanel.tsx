import { Icon } from '../icons';
import type { MissingItem } from '../../core/creative/types';

/** The dedicated "Missing Pieces" panel. */
export function MissingPanel({ items, title = 'Missing pieces' }: { items: MissingItem[]; title?: string }) {
  const blockers = items.filter((i) => i.severity === 'blocker');
  const warns = items.filter((i) => i.severity === 'warn');
  return (
    <section className="card creative-card missing-panel" aria-label={title}>
      <div className="creative-card-head">
        <h3>{Icon.target({ size: 15 })} {title}</h3>
        <span className="spacer" />
        {items.length === 0 ? (
          <span className="chip ok-chip">{Icon.ok({ size: 13 })} Complete</span>
        ) : (
          <span className="chip">{blockers.length ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} · ` : ''}{warns.length} to do</span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="creative-empty">Nothing missing — this project has every required piece.</p>
      ) : (
        <ul className="missing-list">
          {items.map((item, i) => (
            <li key={`${item.kind}-${item.ref ?? i}`} className={`missing-item ${item.severity}`}>
              <span className="missing-dot" aria-hidden="true" />
              <span className="missing-text">
                <span className="missing-label">{item.label}</span>
                <span className="missing-detail">{item.detail}</span>
              </span>
              <span className={`chip sev-${item.severity}`}>{item.severity === 'blocker' ? 'Blocker' : 'To do'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
