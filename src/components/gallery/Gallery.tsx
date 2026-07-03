import { useEffect, useState } from 'react';
import { downloadDataUrl, downloadJson, slugify } from '../../bridge/exporter';
import type { ExportManifest } from '../../core/manifest';
import type { TurboForgeManifestData } from '../../turboForge/types';
import { useStudio, type GalleryItem } from '../../state/store';
import { Icon } from '../icons';

type ManifestWithTurbo = ExportManifest & { turboForge?: TurboForgeManifestData };

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Drawer({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot);
  const m = item.manifest as ManifestWithTurbo;
  const base = slugify(m.prompt);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Render details">
        <div className="drawer-head">
          <h2>Render details</h2>
          <button className="btn icon" type="button" aria-label="Close details" onClick={onClose}>{Icon.close()}</button>
        </div>
        <div className="drawer-body">
          <img src={item.dataUrl} alt={m.prompt || 'Generated render'} />
          <div className="drawer-actions">
            <button className="btn" type="button" onClick={() => downloadDataUrl(item.dataUrl, `${base}-${m.seed}.png`)}>
              {Icon.download()} PNG
            </button>
            <button className="btn" type="button" onClick={() => downloadJson(m, `${base}-${m.seed}.manifest.json`)}>
              {Icon.download()} Manifest JSON
            </button>
            <button className="btn primary" type="button" onClick={() => { restoreSnapshot(item); onClose(); }}>
              {Icon.restore()} Restore graph
            </button>
          </div>
          <dl className="detail-grid">
            <DetailRow label="Prompt">{m.prompt || '—'}</DetailRow>
            {m.negativePrompt ? <DetailRow label="Negative">{m.negativePrompt}</DetailRow> : null}
            <DetailRow label="Seed"><span className="mono">{m.seed}</span></DetailRow>
            <DetailRow label="Sampler">{m.sampler.name} · {m.sampler.steps} steps · cfg {m.sampler.cfg}</DetailRow>
            <DetailRow label="Canvas">{m.canvas.width}×{m.canvas.height}</DetailRow>
            <DetailRow label="Model">
              {m.model ? <>{m.model.name} <span className="chip">{m.model.family}</span> <span className="mono">{m.model.hash}</span></> : '—'}
            </DetailRow>
            <DetailRow label="LoRA stack">
              {m.loras.length === 0 ? '—' : m.loras.map((l) => (
                <span key={l.id} className="chip">{l.name} @ {l.weight}</span>
              ))}
            </DetailRow>
            {m.turboForge ? (
              <DetailRow label="TurboForge">{m.turboForge.backendId} · {m.turboForge.preset}</DetailRow>
            ) : null}
            <DetailRow label="Created">{new Date(item.createdAt).toLocaleString()}</DetailRow>
            <DetailRow label="Graph">v{m.graphVersion} · {m.graph.nodes.length} capsules, {m.graph.edges.length} links</DetailRow>
            <DetailRow label="App">{m.app} {m.appVersion}</DetailRow>
          </dl>
        </div>
      </aside>
    </>
  );
}

export function Gallery() {
  const gallery = useStudio((s) => s.gallery);
  const removeGalleryItem = useStudio((s) => s.removeGalleryItem);
  const setView = useStudio((s) => s.setView);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = gallery.find((g) => g.id === openId) ?? null;

  return (
    <main className="gallery" aria-label="Gallery">
      <div className="gallery-inner">
        {gallery.length === 0 ? (
          <div className="gallery-empty">
            <p>No renders yet. Choose a checkpoint, then press Render.</p>
            <button className="btn" type="button" onClick={() => setView('recipe')}>Go to Recipe View</button>
          </div>
        ) : (
          <div className="gallery-grid">
            {gallery.map((item) => {
              const m = item.manifest as ManifestWithTurbo;
              return (
                <article key={item.id} className="card render-card">
                  <button type="button" className="render-card" onClick={() => setOpenId(item.id)} aria-label={`Open details for ${m.prompt || 'render'}`}>
                    <img src={item.dataUrl} alt={m.prompt || 'Generated render'} />
                    <div className="meta">
                      <span className="p" title={m.prompt}>{m.prompt || 'Untitled render'}</span>
                      <span className="s"><span className="mono">seed {m.seed}</span><span>{new Date(item.createdAt).toLocaleTimeString()}</span></span>
                    </div>
                  </button>
                  <div className="meta">
                    <div className="drawer-actions">
                      <button className="btn icon" type="button" aria-label="Download manifest JSON"
                        onClick={() => downloadJson(m, `${slugify(m.prompt)}-${m.seed}.manifest.json`)}>{Icon.download({ size: 14 })}</button>
                      <button className="btn icon danger" type="button" aria-label="Remove render"
                        onClick={() => removeGalleryItem(item.id)}>{Icon.trash({ size: 14 })}</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {open ? <Drawer item={open} onClose={() => setOpenId(null)} /> : null}
    </main>
  );
}
