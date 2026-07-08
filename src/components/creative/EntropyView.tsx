import { useMemo } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import { scanEntropy, summarizeEntropy } from '../../core/creative/entropy';
import type { EntropyAction, EntropyItem } from '../../core/creative/types';
import '../../styles/creative.css';

const ACTION_LABEL: Record<EntropyAction, string> = {
  archive: 'Archive',
  merge: 'Merge',
  repair: 'Repair',
  retag: 'Retag',
  regenerate: 'Regenerate',
  'promote-to-recipe': 'Promote to recipe',
  delete: 'Delete',
};

function EntropyRow({ item }: { item: EntropyItem }) {
  const resolve = useStudio((s) => s.resolveEntropyItem);
  return (
    <li className={`entropy-item sev-${item.severity}`}>
      <span className="entropy-sev" aria-hidden="true" />
      <span className="entropy-text">
        <span className="entropy-label">{item.label}</span>
        <span className="entropy-detail">{item.detail}</span>
      </span>
      <span className="entropy-actions">
        {item.actions.map((a) => (
          <button
            key={a}
            type="button"
            className={`btn tiny ${a === 'delete' ? 'danger' : ''}`}
            onClick={() => resolve(item, a)}
            title={ACTION_LABEL[a]}
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
      </span>
    </li>
  );
}

/** Entropy Mode: disorder across all projects + the gallery, each with actions. */
export function EntropyView() {
  const brains = useStudio((s) => s.creative.brains);
  const gallery = useStudio((s) => s.gallery);
  const shelf = useStudio((s) => s.shelf);
  const analysisContext = useStudio((s) => s.analysisContext);

  const items = useMemo(
    () => scanEntropy(brains, analysisContext(), new Date()),
    // Recompute when the underlying data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brains, gallery, shelf],
  );
  const summary = summarizeEntropy(items);

  return (
    <main className="studio-page creative-page entropy-page scroll" aria-label="Entropy Mode">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Entropy Mode</p>
            <h1>{Icon.scatter({ size: 22 })} Disorder radar</h1>
            <p className="creative-lead">Duplicates, orphans, broken links, stale prompts and unused work — with a one-click fix for each.</p>
          </div>
          <div className="entropy-summary">
            <span className="entropy-stat high"><b>{summary.high}</b> high</span>
            <span className="entropy-stat medium"><b>{summary.medium}</b> medium</span>
            <span className="entropy-stat low"><b>{summary.low}</b> low</span>
          </div>
        </header>

        {items.length === 0 ? (
          <section className="card creative-card creative-clean">
            <span className="creative-clean-glyph" aria-hidden="true">{Icon.ok({ size: 40 })}</span>
            <h2>All clear</h2>
            <p>No entropy detected across your projects and gallery. Everything is linked, labeled, and in use.</p>
          </section>
        ) : (
          <section className="card creative-card">
            <ul className="entropy-list">
              {items.map((item) => <EntropyRow key={item.id} item={item} />)}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
