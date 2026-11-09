import { useEffect, useMemo, useState } from 'react';
import type { FileEntry, DirectoryListing, FileKind, TextFilePreview } from '../../bridge/files';
import {
  canOpenInDefaultApp, canPreview, canPreviewText, getPreviewUrl, getTextPreview,
} from '../../bridge/files';
import { modificationHistogram } from '../../core/shell/fileActivity';
import { humanFileSize } from '../../core/shell/fileMap';
import { Icon } from '../icons';

function formatDate(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? 'Unknown' : new Date(ms).toLocaleString();
}

function FileIcon({ kind }: { kind: FileKind }) {
  if (kind === 'folder') return <>{Icon.folder({ size: 46 })}</>;
  if (kind === 'image' || kind === 'video') return <>{Icon.image({ size: 44 })}</>;
  if (kind === 'audio') return <>{Icon.pulse({ size: 44 })}</>;
  if (kind === 'code') return <>{Icon.graph({ size: 44 })}</>;
  if (kind === 'document') return <>{Icon.edit({ size: 44 })}</>;
  return <>{Icon.layers({ size: 44 })}</>;
}

function InspectorMedia({ selected }: { selected: FileEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!canPreview(selected)) return;
    let active = true;
    let resource: string | null = null;
    void getPreviewUrl(selected).then((next) => {
      if (!next) return;
      if (!active) { URL.revokeObjectURL(next); return; }
      resource = next;
      setUrl(next);
    }).catch(() => { /* An inaccessible preview does not block selection. */ });
    return () => {
      active = false;
      if (resource) URL.revokeObjectURL(resource);
    };
  }, [selected.path, selected.modifiedMs, selected.sizeBytes]);

  return <div className="files-inspector-preview" aria-label="Selected item preview">
    {url ? <img className="files-thumbnail" alt={'Preview of ' + selected.name} src={url} />
      : <span className={`files-inspector-symbol kind-${selected.kind}`}>
          <FileIcon kind={selected.kind} />
        </span>}
  </div>;
}

function InspectorText({ entry }: { entry: FileEntry }) {
  const [value, setValue] = useState<TextFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setValue(null);
    setError(null);
    void getTextPreview(entry.path).then((result) => {
      if (active) setValue(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [entry.path, entry.modifiedMs, entry.sizeBytes]);

  return <section className="files-inspector-text" aria-label="Read-only text preview">
    <div className="files-inspector-section-head">
      <h3>Text preview</h3><span>READ ONLY</span>
    </div>
    {value ? (
      <>
        <pre tabIndex={0} aria-label={'First lines of ' + entry.name}>{value.text || '(Empty file)'}</pre>
        <small>{value.truncated ? 'First 24 KiB shown' : `${value.bytesShown} bytes shown`}</small>
      </>
    ) : error ? <p className="files-inspector-help">Preview unavailable: {error}</p>
      : <p className="files-inspector-help">Reading selected file…</p>}
  </section>;
}

export function FileInspector({
  selected, listing, onOpen, onRename, onCopyPath, onSelectRelated,
}: {
  selected: FileEntry | null;
  listing: DirectoryListing | null;
  onOpen: (entry: FileEntry) => void;
  onRename: () => void;
  onCopyPath: (path: string) => void;
  onSelectRelated: (entry: FileEntry) => void;
}) {
  const histogram = useMemo(() =>
    modificationHistogram(listing?.entries ?? [], selected?.path ?? null),
    [listing, selected?.path]);
  const peak = Math.max(1, ...histogram.map((item) => item.count));
  const related = useMemo(() => !selected || !listing ? [] :
    listing.entries.filter((entry) => entry.kind === selected.kind && entry.path !== selected.path)
      .slice(0, 5), [listing, selected]);

  return <aside className="files-inspector" aria-label="Selected file details">
    <div className="files-inspector-section-head">
      <h3>Inspector</h3><span>LOCAL / READ FIRST</span>
    </div>
    {selected ? (
      <>
        <InspectorMedia selected={selected} />
        <div className="files-inspector-identity">
          <h2 title={selected.name}>{selected.name}</h2>
          <span className="files-inspector-kind">{selected.isDirectory ? 'Folder' : selected.kind}</span>
        </div>
        <div className="files-inspector-meta">
          <div><b>Location</b><span className="files-path-text">{selected.path}</span></div>
          <div><b>Modified</b><span>{formatDate(selected.modifiedMs)}</span></div>
          <div><b>Size</b><span>{humanFileSize(selected.sizeBytes)}</span></div>
          <div><b>Type</b><span>{selected.isDirectory ? 'Directory' : selected.extension.toUpperCase() || 'Unknown'}</span></div>
          {selected.isSymlink ? <div><b>Link</b><span>Filesystem link</span></div> : null}
          {selected.isReadOnly ? <div><b>Access</b><span>Read-only</span></div> : null}
        </div>
        <div className="files-inspector-actions">
          <button className="btn primary" type="button"
            disabled={!selected.isDirectory && !canOpenInDefaultApp(selected)}
            onClick={() => onOpen(selected)}>
            {selected.isDirectory ? 'Explore folder' : canOpenInDefaultApp(selected) ? 'Open file' : 'Restricted type'}
          </button>
          <button className="btn" type="button" onClick={() => onCopyPath(selected.path)}
            title="Copy the selected file path">{Icon.copy({ size: 14 })} Copy path</button>
          <button className="btn" type="button" onClick={onRename}>
            {Icon.edit({ size: 14 })} Rename
          </button>
        </div>
        {!selected.isDirectory && !canOpenInDefaultApp(selected) ? (
          <p className="files-inspector-help">Potentially executable or unknown file types are not launched here. Explorer fallback is available.</p>
        ) : null}

        {canPreviewText(selected) ? <InspectorText entry={selected} /> : null}
        {selected.kind === 'audio' ? (
          <p className="files-inspector-help">Audio waveform decoding is not enabled in this version. The file can still open in your chosen audio application.</p>
        ) : null}

        {related.length > 0 ? <section className="files-related">
          <div className="files-inspector-section-head">
            <h3>Same kind, this folder</h3><span>{related.length} SHOWN</span>
          </div>
          {related.map((entry) => <button type="button" key={entry.path}
            title={entry.path} onClick={() => onSelectRelated(entry)}>
            <span>{entry.name}</span>{Icon.link({ size: 13 })}
          </button>)}
        </section> : null}
      </>
    ) : (
      <div className="files-inspector-idle">
        <span>{Icon.sparkle({ size: 32 })}</span>
        <h2>Explore a star</h2>
        <p>Choose a real file or folder to see its metadata, relevant previews, and explicit actions.</p>
      </div>
    )}
    {listing ? <section className="files-inspector-activity">
      <div className="files-inspector-section-head">
        <h3>Modified dates</h3><span>THIS FOLDER</span>
      </div>
      <div className="files-inspector-histogram" role="img"
        aria-label={'Distribution of modification dates for ' + listing.entries.length + ' loaded entries'}>
        {histogram.map((bucket, i) => (
          <span key={i} className={bucket.selected ? 'selected' : ''}
            style={{ height: `${5 + (bucket.count / peak) * 95}%` }}
            title={`${bucket.count} files in date range ${i + 1}`} />
        ))}
      </div>
      <p className="files-inspector-help">Observed last-modified dates, not a version history.</p>
    </section> : null}
    <p className="files-inspector-note">
      Local-only browsing. No automatic moves, deletion, or background indexing.
    </p>
  </aside>;
}
