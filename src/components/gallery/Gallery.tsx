import { useEffect, useMemo, useState } from 'react';
import { downloadDataUrl, downloadJson, downloadText, slugify } from '../../bridge/exporter';
import type { ExportManifest } from '../../core/manifest';
import { buildShowcaseHtml } from '../../core/share/showcase';
import { showcaseInputFromRenders } from '../../core/share/showcaseInput';
import { publishShowcase, isPublishConfigured, PUBLISH_MAX_BYTES } from '../../bridge/publish';
import { fallbackReasonFor, isFallbackRender, renderBackendLabel, renderModeLabel } from '../../core/renderHonesty';
import { allTags, collectionCounts, filterGallery } from '../../core/gallery/filter';
import type { TurboForgeManifestData } from '../../turboForge/types';
import { useStudio, type GalleryItem } from '../../state/store';
import { Icon } from '../icons';

type ManifestWithTurbo = ExportManifest & { turboForge?: TurboForgeManifestData };

function mediaExtension(item: GalleryItem): string {
  return item.extension ?? (item.mimeType === 'image/gif' ? 'gif' : 'png');
}

function MediaPreview({ item, alt }: { item: GalleryItem; alt: string }) {
  if (item.mimeType?.startsWith('video/')) {
    return <video src={item.dataUrl} controls loop muted playsInline />;
  }
  return <img src={item.dataUrl} alt={alt} />;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Collection <select> + tag editor used inside the drawer. */
function DrawerOrganizer({ item }: { item: GalleryItem }) {
  const collections = useStudio((s) => s.collections);
  const assignToCollection = useStudio((s) => s.assignToCollection);
  const addTag = useStudio((s) => s.addTag);
  const removeTag = useStudio((s) => s.removeTag);
  const [tagDraft, setTagDraft] = useState('');

  const commitTag = () => {
    const t = tagDraft.trim();
    if (t) void addTag(item.id, t);
    setTagDraft('');
  };

  return (
    <div className="gc-organizer">
      <label className="gc-field">
        <span className="gc-field-label">Collection</span>
        <select
          value={item.collectionId ?? ''}
          onChange={(e) => void assignToCollection(item.id, e.target.value || null)}
        >
          <option value="">Uncategorized</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <div className="gc-field">
        <span className="gc-field-label" id={`tags-${item.id}`}>Tags</span>
        <div className="gc-tag-editor" aria-labelledby={`tags-${item.id}`}>
          {(item.tags ?? []).map((tag) => (
            <span key={tag} className="chip gc-tag">
              {tag}
              <button
                type="button"
                className="gc-tag-x"
                aria-label={`Remove tag ${tag}`}
                onClick={() => void removeTag(item.id, tag)}
              >×</button>
            </span>
          ))}
          <input
            type="text"
            className="gc-tag-input"
            placeholder="Add tag…"
            aria-label="Add tag"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTag(); } }}
            onBlur={commitTag}
          />
        </div>
      </div>
    </div>
  );
}

function Drawer({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot);
  const m = item.manifest as ManifestWithTurbo;
  const base = slugify(m.prompt);
  const ext = mediaExtension(item);
  const fallback = isFallbackRender(item);
  const fallbackReason = fallbackReasonFor(item);

  const [publishState, setPublishState] = useState<
    { k: 'idle' } | { k: 'busy' } | { k: 'done'; url: string; copied: boolean } | { k: 'err'; msg: string }
  >({ k: 'idle' });

  // Export a single self-contained Showcase HTML file for this render.
  const shareShowcase = () => {
    const source = {
      dataUrl: item.dataUrl,
      mediaType: item.mediaType ?? ('image' as const),
      mimeType: item.mimeType,
      manifest: item.manifest,
    };
    const title = m.prompt ? m.prompt.slice(0, 60) : 'LumenDeck render';
    const input = showcaseInputFromRenders(title, [source], new Date());
    let result = buildShowcaseHtml(input);
    if (result.oversized) {
      const isVideo = !!item.mimeType && item.mimeType.startsWith('video/');
      if (isVideo) {
        result = buildShowcaseHtml({ ...input, posterOnly: true });
        window.alert('This clip is large, so the shared file omits the video (poster-only) to keep the size reasonable.');
      } else {
        window.alert('This render is very large (over 50 MB); the shared file will be large too.');
      }
    }
    downloadText(result.html, `${base}.showcase.html`);
  };

  // Publish the showcase to a public URL and copy the link. Poster-only if the
  // showcase would exceed the 25MB publish cap; honest about the clipboard result.
  const publishShare = async () => {
    setPublishState({ k: 'busy' });
    try {
      const source = { dataUrl: item.dataUrl, mediaType: item.mediaType ?? ('image' as const), mimeType: item.mimeType, manifest: item.manifest };
      const title = m.prompt ? m.prompt.slice(0, 60) : 'LumenDeck render';
      const input = showcaseInputFromRenders(title, [source], new Date());
      let result = buildShowcaseHtml(input);
      if (result.bytes > PUBLISH_MAX_BYTES) {
        const poster = buildShowcaseHtml({ ...input, posterOnly: true });
        if (poster.bytes > PUBLISH_MAX_BYTES) {
          setPublishState({ k: 'err', msg: 'Too large to publish (over 25 MB) even without the video — use "Share showcase" to save a file instead.' });
          return;
        }
        result = poster;
      }
      const { url } = await publishShowcase(result.html, base);
      let copied = false;
      try { await navigator.clipboard?.writeText(url); copied = true; } catch { /* clipboard optional */ }
      setPublishState({ k: 'done', url, copied });
    } catch (err) {
      setPublishState({ k: 'err', msg: err instanceof Error ? err.message : String(err) });
    }
  };

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
          <MediaPreview item={item} alt={m.prompt || 'Generated render'} />
          {fallback ? (
            <div className="fallback-warning" role="alert">
              <strong>This was not a clean real model render.</strong>
              <span>LumenDeck used a procedural/mock fallback.</span>
              {fallbackReason ? <span>{fallbackReason}</span> : null}
            </div>
          ) : null}
          <DrawerOrganizer item={item} />
          <div className="drawer-actions">
            <button className="btn" type="button" onClick={() => downloadDataUrl(item.dataUrl, `${base}-${m.seed}.${ext}`)}>
              {Icon.download()} {ext.toUpperCase()}
            </button>
            <button className="btn" type="button" onClick={() => downloadJson(m, `${base}-${m.seed}.manifest.json`)}>
              {Icon.download()} Manifest JSON
            </button>
            <button className="btn" type="button" onClick={shareShowcase} title="Export a self-contained showcase page (opens in any browser; embeds the .lumen for remix)">
              {Icon.link()} Share showcase
            </button>
            {isPublishConfigured() ? (
              <button className="btn" type="button" onClick={() => void publishShare()} disabled={publishState.k === 'busy'} title="Upload the showcase and get a public link (anyone with the link can view)">
                {Icon.link()} {publishState.k === 'busy' ? 'Publishing…' : 'Publish → link'}
              </button>
            ) : null}
            <button className="btn primary" type="button" onClick={() => { restoreSnapshot(item); onClose(); }}>
              {Icon.restore()} Restore graph
            </button>
          </div>
          {publishState.k === 'done' ? (
            <div className="publish-result" role="status">
              <span className="publish-ok">{Icon.ok({ size: 13 })} {publishState.copied ? 'Public link copied' : 'Public link ready'}</span>
              <a className="publish-url mono" href={publishState.url} target="_blank" rel="noopener noreferrer">{publishState.url}</a>
              <span className="publish-note">Anyone with this link can view the render. Published links stay up until removed by the project owner.</span>
            </div>
          ) : publishState.k === 'err' ? (
            <div className="publish-result error" role="alert">{Icon.error({ size: 13 })} Publish failed: {publishState.msg}</div>
          ) : null}
          <dl className="detail-grid">
            <DetailRow label="Prompt">{m.prompt || '—'}</DetailRow>
            {m.negativePrompt ? <DetailRow label="Negative">{m.negativePrompt}</DetailRow> : null}
            <DetailRow label="Seed"><span className="mono">{m.seed}</span></DetailRow>
            <DetailRow label="Sampler">{m.sampler.name} · {m.sampler.steps} steps · cfg {m.sampler.cfg}</DetailRow>
            <DetailRow label="Canvas">{m.canvas.width}×{m.canvas.height}</DetailRow>
            <DetailRow label="Media">
              {m.media?.type ?? item.mediaType ?? 'image'} | {m.media?.format ?? ext}
              {m.media?.type === 'video' ? ` | ${m.media.frameCount} frames @ ${m.media.fps} fps` : ''}
            </DetailRow>
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
            <DetailRow label="Render mode">{renderModeLabel(item)}</DetailRow>
            <DetailRow label="Backend">{renderBackendLabel(item)}</DetailRow>
            {fallbackReason ? <DetailRow label="Fallback reason">{fallbackReason}</DetailRow> : null}
            <DetailRow label="Created">{new Date(item.createdAt).toLocaleString()}</DetailRow>
            <DetailRow label="Graph">v{m.graphVersion} · {m.graph.nodes.length} capsules, {m.graph.edges.length} links</DetailRow>
            <DetailRow label="App">{m.app} {m.appVersion}</DetailRow>
          </dl>
        </div>
      </aside>
    </>
  );
}

/** Search + collection selector + tag chip row above the grid. */
function FilterBar({
  query, setQuery,
  collectionId, setCollectionId,
  activeTags, toggleTag,
}: {
  query: string;
  setQuery: (v: string) => void;
  collectionId: string | null | undefined;
  setCollectionId: (v: string | null | undefined) => void;
  activeTags: string[];
  toggleTag: (t: string) => void;
}) {
  const gallery = useStudio((s) => s.gallery);
  const collections = useStudio((s) => s.collections);
  const createCollection = useStudio((s) => s.createCollection);
  const renameCollection = useStudio((s) => s.renameCollection);
  const deleteCollection = useStudio((s) => s.deleteCollection);

  const counts = useMemo(() => collectionCounts(gallery), [gallery]);
  const tags = useMemo(() => allTags(gallery), [gallery]);

  // Map the tri-state selector value to a plain string for <select>.
  const selectValue = collectionId === undefined ? '__all__' : collectionId === null ? '__uncat__' : collectionId;
  const onSelect = (v: string) => {
    if (v === '__all__') setCollectionId(undefined);
    else if (v === '__uncat__') setCollectionId(null);
    else setCollectionId(v);
  };

  const activeCollection = typeof collectionId === 'string' ? collections.find((c) => c.id === collectionId) : undefined;

  const onNew = () => {
    const name = window.prompt('New collection name');
    if (name && name.trim()) void createCollection(name.trim());
  };
  const onRename = () => {
    if (!activeCollection) return;
    const name = window.prompt('Rename collection', activeCollection.name);
    if (name && name.trim()) void renameCollection(activeCollection.id, name.trim());
  };
  const onDelete = () => {
    if (!activeCollection) return;
    if (window.confirm(`Delete collection "${activeCollection.name}"? Its renders become uncategorized (never deleted).`)) {
      void deleteCollection(activeCollection.id);
      setCollectionId(undefined);
    }
  };

  return (
    <div className="gc-filterbar" role="search" aria-label="Filter gallery">
      <div className="gc-filter-row">
        <label className="gc-field gc-search">
          <span className="gc-field-label vh">Search renders</span>
          <input
            type="search"
            placeholder="Search prompt, negative, model…"
            aria-label="Search renders"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="gc-field gc-collection">
          <span className="gc-field-label vh">Collection</span>
          <select value={selectValue} onChange={(e) => onSelect(e.target.value)} aria-label="Filter by collection">
            <option value="__all__">All ({counts.all})</option>
            <option value="__uncat__">Uncategorized ({counts.uncategorized})</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({counts.byId[c.id] ?? 0})</option>
            ))}
          </select>
        </label>
        <div className="gc-collection-actions">
          <button className="btn icon" type="button" aria-label="New collection" title="New collection" onClick={onNew}>
            {Icon.plus({ size: 14 })}
          </button>
          <button className="btn icon" type="button" aria-label="Rename collection" title="Rename collection"
            disabled={!activeCollection} onClick={onRename}>
            {Icon.folder({ size: 14 })}
          </button>
          <button className="btn icon danger" type="button" aria-label="Delete collection" title="Delete collection"
            disabled={!activeCollection} onClick={onDelete}>
            {Icon.trash({ size: 14 })}
          </button>
        </div>
      </div>
      {tags.length > 0 ? (
        <div className="gc-tag-row" role="group" aria-label="Filter by tags">
          {tags.map((tag) => {
            const on = activeTags.some((t) => t.toLowerCase() === tag.toLowerCase());
            return (
              <button
                key={tag}
                type="button"
                className={`chip gc-tag-filter${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleTag(tag)}
              >{tag}</button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function Gallery() {
  const gallery = useStudio((s) => s.gallery);
  const galleryReady = useStudio((s) => s.galleryReady);
  const galleryDurable = useStudio((s) => s.galleryDurable);
  const removeGalleryItem = useStudio((s) => s.removeGalleryItem);
  const setView = useStudio((s) => s.setView);

  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collectionId, setCollectionId] = useState<string | null | undefined>(undefined);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const toggleTag = (tag: string) =>
    setActiveTags((prev) =>
      prev.some((t) => t.toLowerCase() === tag.toLowerCase())
        ? prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...prev, tag],
    );

  const visible = useMemo(
    () => filterGallery(gallery, { query, collectionId, tags: activeTags }),
    [gallery, query, collectionId, activeTags],
  );
  const open = gallery.find((g) => g.id === openId) ?? null;
  const filtering = query.trim() !== '' || collectionId !== undefined || activeTags.length > 0;

  return (
    <main className="gallery" aria-label="Gallery">
      <div className="gallery-inner">
        <div className="storage-warning">
          <strong>Renders are saved in your browser (IndexedDB).</strong>
          <span>
            {galleryDurable
              ? 'Durable local storage — but export important renders and manifests as a backup.'
              : 'IndexedDB is unavailable here, so renders last only for this session. Export anything you want to keep.'}
          </span>
        </div>
        {!galleryReady ? (
          <div className="gallery-empty" aria-live="polite">
            <p>Loading gallery…</p>
          </div>
        ) : gallery.length === 0 ? (
          <div className="gallery-empty">
            <p>No renders yet. Choose a checkpoint, then press Render.</p>
            <button className="btn" type="button" onClick={() => setView('recipe')}>Go to Recipe View</button>
          </div>
        ) : (
          <>
            <FilterBar
              query={query} setQuery={setQuery}
              collectionId={collectionId} setCollectionId={setCollectionId}
              activeTags={activeTags} toggleTag={toggleTag}
            />
            {visible.length === 0 ? (
              <div className="gallery-empty">
                <p>No renders match the current filter.</p>
                {filtering ? (
                  <button className="btn" type="button" onClick={() => { setQuery(''); setCollectionId(undefined); setActiveTags([]); }}>
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="gallery-grid">
                {visible.map((item) => {
                  const m = item.manifest as ManifestWithTurbo;
                  const fallback = isFallbackRender(item);
                  return (
                    <article key={item.id} className="card render-card">
                      <button type="button" className="render-card" onClick={() => setOpenId(item.id)} aria-label={`Open details for ${m.prompt || 'render'}`}>
                        <MediaPreview item={item} alt={m.prompt || 'Generated render'} />
                        <span className={`render-badge ${fallback ? 'fallback' : ''}`}>
                          {fallback ? 'Fallback' : renderModeLabel(item)}
                        </span>
                        <div className="meta">
                          <span className="p" title={m.prompt}>{m.prompt || 'Untitled render'}</span>
                          <span className="s">
                            <span className="mono">{m.media?.type === 'video' || item.mediaType === 'video' ? 'video' : 'seed'} {m.seed}</span>
                            <span>{renderBackendLabel(item)}</span>
                          </span>
                        </div>
                      </button>
                      {(item.tags ?? []).length > 0 ? (
                        <div className="gc-card-tags" aria-label="Tags">
                          {(item.tags ?? []).map((tag) => (
                            <span key={tag} className="chip gc-tag">{tag}</span>
                          ))}
                        </div>
                      ) : null}
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
          </>
        )}
      </div>
      {open ? <Drawer item={open} onClose={() => setOpenId(null)} /> : null}
    </main>
  );
}
