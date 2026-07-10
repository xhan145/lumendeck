import { useState } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type RowState = { k: 'idle' } | { k: 'busy' } | { k: 'err'; status: number; msg: string };

export function PublishedLinks() {
  const shares = useStudio((s) => s.publishedShares);
  const unpublishShare = useStudio((s) => s.unpublishShare);
  const removePublishedShare = useStudio((s) => s.removePublishedShare);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [copied, setCopied] = useState<string | null>(null);

  if (shares.length === 0) return null;

  const setRow = (id: string, st: RowState) => setRows((r) => ({ ...r, [id]: st }));

  const copy = async (id: string, url: string) => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard optional */
    }
  };

  const unpublish = async (id: string) => {
    setRow(id, { k: 'busy' });
    const r = await unpublishShare(id);
    if (r.ok) return; // store dropped the row; this component re-renders without it
    setRow(id, { k: 'err', status: r.status, msg: r.error ?? 'Unpublish failed' });
  };

  const sorted = [...shares].sort((a, b) => b.publishedAt - a.publishedAt);
  const now = Date.now();

  return (
    <section className="card creative-card published-links">
      <div className="creative-card-head">
        <h3>{Icon.link({ size: 15 })} Published links</h3>
        <span className="spacer" />
        <span className="chip">{shares.length}</span>
      </div>
      <ul className="published-list">
        {sorted.map((s) => {
          const st = rows[s.id] ?? { k: 'idle' as const };
          return (
            <li key={s.id} className="published-row">
              <div className="published-main">
                <span className="published-title">{s.title || 'Untitled'}</span>
                <a className="published-url mono" href={s.url} target="_blank" rel="noopener noreferrer">{s.url}</a>
                <span className="published-meta">{s.kind} · {relTime(s.publishedAt, now)}</span>
              </div>
              <div className="published-actions">
                <button className="btn tiny" type="button" onClick={() => void copy(s.id, s.url)}>{copied === s.id ? 'Copied' : 'Copy'}</button>
                <a className="btn tiny" href={s.url} target="_blank" rel="noopener noreferrer">Open</a>
                <button className="btn tiny danger" type="button" disabled={st.k === 'busy'} onClick={() => void unpublish(s.id)}>
                  {st.k === 'busy' ? 'Removing…' : 'Unpublish'}
                </button>
              </div>
              {st.k === 'err' ? (
                <div className="published-error" role="alert">
                  {st.status === 403 ? (
                    <>
                      <span>{Icon.error({ size: 12 })} Couldn’t verify ownership of this link.</span>
                      <button className="btn tiny" type="button" onClick={() => removePublishedShare(s.id)}>Forget locally</button>
                    </>
                  ) : (
                    <>
                      <span>{Icon.error({ size: 12 })} {st.msg}</span>
                      <button className="btn tiny" type="button" onClick={() => void unpublish(s.id)}>Retry</button>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
