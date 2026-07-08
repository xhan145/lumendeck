import { useMemo } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import { collectProof, type ProofArtifact } from '../../core/creative/proof';
import '../../styles/creative.css';

const KIND_ICON: Record<ProofArtifact['kind'], (p?: { size?: number }) => React.ReactNode> = {
  export: Icon.download,
  link: Icon.link,
  'shipped-render': Icon.image,
};

function fmtDate(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Proof Mode: concrete shipped artifacts, separated from draft work-in-progress. */
export function ProofView() {
  const brains = useStudio((s) => s.creative.brains);
  const gallery = useStudio((s) => s.gallery);

  const proof = useMemo(() => {
    const ids = new Set(gallery.map((g) => g.id));
    return collectProof(brains, (id) => ids.has(id));
  }, [brains, gallery]);

  const draftProjects = brains.filter((b) => b.status !== 'shipped' && b.status !== 'release-ready' && b.status !== 'archived');
  const renderById = new Map(gallery.map((g) => [g.id, g]));

  return (
    <main className="studio-page creative-page proof-page scroll" aria-label="Proof Mode">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Proof Mode</p>
            <h1>{Icon.trophy({ size: 22 })} Shipped &amp; real</h1>
            <p className="creative-lead">Only concrete deliverables: exports, release packs, published links, and final renders from shipped projects.</p>
          </div>
          <div className="proof-summary">
            <span className="proof-stat"><b>{proof.exports}</b> exports</span>
            <span className="proof-stat"><b>{proof.links}</b> links</span>
            <span className="proof-stat"><b>{proof.shippedRenders}</b> finals</span>
          </div>
        </header>

        {proof.artifacts.length === 0 ? (
          <section className="card creative-card creative-clean">
            <span className="creative-clean-glyph" aria-hidden="true">{Icon.trophy({ size: 40 })}</span>
            <h2>Nothing shipped yet</h2>
            <p>Build a release pack or mark a project shipped and its artifacts appear here as proof.</p>
          </section>
        ) : (
          <section className="proof-grid">
            {proof.artifacts.map((a) => {
              const render = a.ref ? renderById.get(a.ref) : undefined;
              return (
                <article key={a.id} className="card creative-card proof-artifact">
                  <div className="proof-artifact-media">
                    {render ? (
                      <img src={render.dataUrl} alt={a.label} />
                    ) : (
                      <span className="proof-artifact-glyph" aria-hidden="true">{(KIND_ICON[a.kind] ?? Icon.trophy)({ size: 28 })}</span>
                    )}
                  </div>
                  <div className="proof-artifact-body">
                    <span className="proof-artifact-kind">{(KIND_ICON[a.kind] ?? Icon.trophy)({ size: 12 })} {a.kind.replace('-', ' ')}</span>
                    <span className="proof-artifact-label">{a.label}</span>
                    <span className="proof-artifact-detail">{a.detail}</span>
                    <span className="proof-artifact-foot">
                      <span>{fmtDate(a.at)}</span>
                      {a.fileName ? <span className="proof-artifact-file">{a.fileName}</span> : null}
                    </span>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        <section className="card creative-card proof-drafts">
          <div className="creative-card-head">
            <h3>{Icon.edit({ size: 15 })} Drafts &amp; in progress</h3>
            <span className="spacer" />
            <span className="chip">{draftProjects.length}</span>
          </div>
          {draftProjects.length === 0 ? (
            <p className="creative-empty">No drafts — everything is shipped or archived.</p>
          ) : (
            <ul className="proof-draft-list">
              {draftProjects.map((b) => (
                <li key={b.id}>
                  <span className="proof-draft-name">{b.name}</span>
                  <span className={`chip status-${b.status}`}>{b.status.replace('-', ' ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
