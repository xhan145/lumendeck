import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canOpenInDefaultApp, canPreview, createDirectory, filesAvailable, getPreviewUrl, listDirectory,
  listLocations, openFile, renameFile,
  type DirectoryListing, type FileEntry, type FileKind, type FileLocation,
} from '../../bridge/files';
import { runRecoveryAction } from '../../bridge/shellRecovery';
import { filterAndSortFiles, humanFileSize, makeFileStars, type FileSort } from '../../core/shell/fileMap';
import { Icon } from '../icons';
import { FileConstellation } from './FileConstellation';
import '../../styles/files.css';

type FilesMode = 'list' | 'grid' | 'constellation';
type EditAction = 'new-folder' | 'rename' | null;

function FileGlyph({ kind, size = 21 }: { kind: FileKind; size?: number }) {
  if (kind === 'folder') return <>{Icon.folder({ size })}</>;
  if (kind === 'image' || kind === 'video') return <>{Icon.image({ size })}</>;
  if (kind === 'audio') return <>{Icon.pulse({ size })}</>;
  if (kind === 'code') return <>{Icon.graph({ size })}</>;
  if (kind === 'document') return <>{Icon.edit({ size })}</>;
  return <>{Icon.layers({ size })}</>;
}

function FileThumbnail({ entry }: { entry: FileEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!canPreview(entry)) return;
    let active = true;
    let generated: string | null = null;
    void getPreviewUrl(entry).then((next) => {
      if (!next) return;
      if (!active) { URL.revokeObjectURL(next); return; }
      generated = next;
      setUrl(next);
    }).catch(() => { /* Non-raster/large/inaccessible files retain their icon. */ });
    return () => {
      active = false;
      if (generated) URL.revokeObjectURL(generated);
    };
  }, [entry.path, entry.modifiedMs, entry.sizeBytes, entry.extension]);

  return url
    ? <img className="files-thumbnail" src={url} alt="" loading="lazy" />
    : <span className={`files-file-icon kind-${entry.kind}`}><FileGlyph kind={entry.kind} size={25} /></span>;
}

function dateLabel(ms: number | null): string {
  return ms === null ? 'Unknown' : new Date(ms).toLocaleString();
}

function folderLabel(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function FilesWorkspace() {
  const native = filesAvailable();
  const [locations, setLocations] = useState<FileLocation[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [mode, setMode] = useState<FilesMode>('constellation');
  const [sort, setSort] = useState<FileSort>('name');
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editAction, setEditAction] = useState<EditAction>(null);
  const [editName, setEditName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestId = useRef(0);
  const addressRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!native) { setLoading(false); return; }
    let live = true;
    void listLocations().then((items) => {
      if (live) setLocations(items);
    }).catch((reason) => {
      if (live) setError(String(reason));
    });
    return () => { live = false; };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    void listDirectory(targetPath ?? undefined).then((folder) => {
      if (!active || id !== requestId.current) return;
      setListing(folder);
      setAddress(folder.path);
      setSelectedPath((prev) => prev && folder.entries.some((item) => item.path === prev) ? prev : null);
    }).catch((reason) => {
      if (!active || id !== requestId.current) return;
      // Never show stale files under a failed address/navigation target.
      setListing(null);
      setSelectedPath(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active && id === requestId.current) setLoading(false);
    });
    return () => { active = false; };
  }, [native, targetPath, refreshKey]);

  const navigate = (path: string) => {
    if (busy) return;
    const destination = path.trim();
    if (!destination) return;
    if (listing?.path.toLowerCase() === destination.toLowerCase()) {
      setAddress(listing.path);
      return;
    }
    if (!listing && targetPath?.toLowerCase() === destination.toLowerCase()) {
      // Retry an address that failed previously rather than silently no-op.
      refresh();
      return;
    }
    if (listing) setHistory((stack) => [...stack.slice(-29), listing.path]);
    setListing(null);
    setLoading(true);
    setAddress(destination);
    setTargetPath(destination);
    setSelectedPath(null);
    setQuery('');
    setEditAction(null);
    setNotice(null);
    setError(null);
  };

  const goBack = () => {
    if (busy || history.length === 0) return;
    const previous = history[history.length - 1];
    setHistory((stack) => stack.slice(0, -1));
    setListing(null);
    setLoading(true);
    setTargetPath(previous);
    setAddress(previous);
    setSelectedPath(null);
    setQuery('');
    setEditAction(null);
    setError(null);
    setNotice(null);
  };

  const refresh = () => setRefreshKey((count) => count + 1);
  const shown = useMemo(
    () => filterAndSortFiles(listing?.entries ?? [], query, sort),
    [listing, query, sort],
  );
  const selected = listing?.entries.find((item) => item.path === selectedPath) ?? null;
  const visibleStars = useMemo(() => makeFileStars(shown), [shown]);

  const activate = async (entry: FileEntry) => {
    if (entry.isDirectory) {
      navigate(entry.path);
      return;
    }
    if (!canOpenInDefaultApp(entry)) {
      setError('LumenDeck cannot open this file type directly yet. Use Explorer fallback to open it intentionally.');
      return;
    }
    setError(null);
    try {
      await openFile(entry.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const beginEdit = (action: Exclude<EditAction, null>) => {
    setEditAction(action);
    setEditName(action === 'rename' ? selected?.name ?? '' : '');
    setError(null);
  };

  const commitEdit = async () => {
    if (!listing || busy || !editAction) return;
    setBusy(true);
    setError(null);
    try {
      if (editAction === 'new-folder') {
        await createDirectory(listing.path, editName);
        setNotice(`Folder "${editName}" created.`);
      } else {
        if (!selected) return;
        await renameFile(selected.path, editName);
        setSelectedPath(null);
        setNotice('Item renamed.');
      }
      setEditAction(null);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      // Do not steal key events from an open dialog or from browser-only mode.
      if (!native || busy || event.defaultPrevented ||
          document.querySelector('[aria-modal="true"]')) return;
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
      }
      if (event.altKey && event.key === 'ArrowUp' && listing?.parent) {
        event.preventDefault();
        navigate(listing.parent);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });

  return (
    <main className="files-workspace" aria-label="LumenDeck Files">
      <header className="files-header">
        <div>
          <p className="page-kicker">LumenDeck / Files</p>
          <h1>Files, in your orbit.</h1>
          <p>Real local paths. No hidden copies or automatic file changes.</p>
        </div>
        <button className="btn" type="button" disabled={!native}
          title="Open the original Windows file manager"
          onClick={() => void runRecoveryAction('explorer').catch((e) => setError(String(e)))}>
          {Icon.folder({ size: 15 })} Explorer fallback
        </button>
      </header>

      {!native ? (
        <div className="files-unsupported" role="status">
          <h2>Native Files requires the LumenDeck desktop app.</h2>
          <p>The browser preview cannot read your Windows drives. Open the native Tauri window using <code>npm.cmd run tauri:dev</code>.</p>
        </div>
      ) : (
        <div className="files-layout">
          <aside className="files-places" aria-label="Places and drives">
            <h2>Places</h2>
            {locations.filter((place) => place.kind !== 'drive').map((place) => (
              <button key={place.path} className={listing?.path === place.path ? 'active' : ''}
                type="button" title={place.path} onClick={() => navigate(place.path)}>
                {place.kind === 'home' ? Icon.home({ size: 16 }) : Icon.folder({ size: 16 })}
                <span>{place.label}</span>
              </button>
            ))}
            <h2>Drives</h2>
            {locations.filter((place) => place.kind === 'drive').map((place) => (
              <button key={place.path} className={listing?.path === place.path ? 'active' : ''}
                type="button" title={place.path} onClick={() => navigate(place.path)}>
                {Icon.layers({ size: 16 })}<span>{place.label}</span>
              </button>
            ))}
          </aside>

          <section className="files-main" aria-label="File browser">
            <div className="files-toolbar">
              <div className="files-location-tools">
                <button className="btn icon" type="button" aria-label="Go back" title="Go back (Alt+Left)"
                  disabled={!history.length || busy} onClick={goBack}>‹</button>
                <button className="btn icon" type="button" aria-label="Parent folder" title="Parent folder (Alt+Up)"
                  disabled={!listing?.parent || busy} onClick={() => listing?.parent && navigate(listing.parent)}>{Icon.folder({ size: 16 })}</button>
                <button className="btn icon" type="button" aria-label="Refresh files" title="Refresh"
                  disabled={busy} onClick={refresh}>{Icon.restore({ size: 16 })}</button>
              </div>
              <form className="files-path" onSubmit={(e) => { e.preventDefault(); navigate(address); }}>
                <input ref={addressRef} value={address} disabled={busy} aria-label="Folder path (Ctrl+L)"
                  spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
                <button className="btn" type="submit" disabled={busy} title="Navigate to folder">Go</button>
              </form>
            </div>

            <div className="files-controls">
              <label className="files-filter">
                {Icon.target({ size: 16 })}
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  aria-label="Filter current folder" placeholder="Filter this folder..." />
              </label>
              <label className="files-sort">
                <span>Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as FileSort)}>
                  <option value="name">Name</option>
                  <option value="type">Type</option>
                  <option value="modified">Modified</option>
                  <option value="size">Size</option>
                </select>
              </label>
              <div className="files-mode" role="group" aria-label="File viewing mode">
                <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>List</button>
                <button type="button" aria-pressed={mode === 'grid'} onClick={() => setMode('grid')}>Grid</button>
                <button type="button" aria-pressed={mode === 'constellation'} onClick={() => setMode('constellation')}>✦ Constellation</button>
              </div>
              <button className="btn files-new-button" type="button" disabled={!listing || loading}
                onClick={() => beginEdit('new-folder')}>{Icon.plus({ size: 15 })} New folder</button>
            </div>

            {editAction ? (
              <form className="files-editbar" onSubmit={(e) => { e.preventDefault(); void commitEdit(); }}>
                <label>
                  {editAction === 'rename' ? 'Rename item' : 'New folder name'}
                  <input value={editName} autoFocus maxLength={220}
                    onChange={(e) => setEditName(e.target.value)} />
                </label>
                <button className="btn primary" type="submit" disabled={busy || !editName.trim()}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button className="btn" type="button" onClick={() => setEditAction(null)} disabled={busy}>Cancel</button>
              </form>
            ) : null}

            {error ? <div className="files-message error" role="alert">{error}</div> : null}
            {notice ? <div className="files-message" role="status">{notice}</div> : null}
            {listing?.truncated ? (
              <div className="files-message" role="status">
                Large folder: showing the first 800 filesystem entries. Open a subfolder to narrow the view.
              </div>
            ) : null}
            {listing && listing.skipped > 0 ? (
              <div className="files-message">Skipped {listing.skipped} inaccessible entries.</div>
            ) : null}

            <div className="files-results" aria-busy={loading}>
              {loading ? <p className="files-loading" role="status">Reading local files…</p> : null}
              {!loading && listing && shown.length === 0 ? <p className="files-empty">
                {query ? 'No matching files in this folder.' : 'This folder is empty.'}
              </p> : null}

              {listing && mode === 'constellation' ? (
                <div className="files-space-layout">
                  <FileConstellation entries={shown} selectedPath={selectedPath}
                    folderName={folderLabel(listing.path)}
                    onSelect={(entry) => setSelectedPath(entry.path)}
                    onOpen={(entry) => { void activate(entry); }}
                    onUnavailable={() => {
                      setMode('list');
                      setNotice('3D is unavailable on this device. Switched to List view.');
                    }} />
                  <div className="files-space-index">
                    <h3>Visible stars <span>{visibleStars.length}</span></h3>
                    <div className="files-space-index-scroll">
                      {visibleStars.map(({ entry }) => (
                        <button type="button" key={entry.path}
                          title={entry.path} className={selectedPath === entry.path ? 'selected' : ''}
                          onClick={() => setSelectedPath(entry.path)}
                          onDoubleClick={() => void activate(entry)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void activate(entry); } }}>
                          <FileGlyph kind={entry.kind} size={15} />
                          <span>{entry.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {listing && mode === 'list' ? (
                <div className="files-list" role="group" aria-label="Folder entries">
                  {shown.map((entry) => (
                    <button type="button" key={entry.path}
                      className={selectedPath === entry.path ? 'selected' : ''}
                      onClick={() => setSelectedPath(entry.path)}
                      onDoubleClick={() => void activate(entry)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void activate(entry); } }}>
                      <span className={`files-list-glyph kind-${entry.kind}`}><FileGlyph kind={entry.kind} size={19} /></span>
                      <span className="files-name" title={entry.name}>{entry.name}</span>
                      <span className="files-type">{entry.isDirectory ? 'Folder' : entry.extension.toUpperCase() || 'File'}</span>
                      <span className="files-size">{humanFileSize(entry.sizeBytes)}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {listing && mode === 'grid' ? (
                <div className="files-grid" role="group" aria-label="Folder entries">
                  {shown.map((entry, index) => (
                    <button type="button" className={selectedPath === entry.path ? 'selected' : ''}
                      key={entry.path} title={entry.path}
                      onClick={() => setSelectedPath(entry.path)}
                      onDoubleClick={() => void activate(entry)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void activate(entry); } }}>
                      <span className="files-grid-visual">
                        {index < 18 && canPreview(entry) ? <FileThumbnail entry={entry} />
                          : <span className={`files-file-icon kind-${entry.kind}`}><FileGlyph kind={entry.kind} size={29} /></span>}
                      </span>
                      <span className="files-grid-name">{entry.name}</span>
                      <small>{entry.isDirectory ? 'Folder' : humanFileSize(entry.sizeBytes)}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <footer className="files-footer">
              <span>{loading ? 'Reading…' : `${shown.length} visible · ${listing?.entries.length ?? 0} loaded`}</span>
              <span>Double-click or press Enter to open · Changes are explicit</span>
            </footer>
          </section>

          <aside className="files-inspector" aria-label="Selected file details">
            <p className="page-kicker">Inspector</p>
            {selected ? (
              <>
                <div className="files-inspector-preview">
                  {canPreview(selected) ? <FileThumbnail entry={selected} />
                    : <span className={`files-file-icon kind-${selected.kind}`}><FileGlyph kind={selected.kind} size={44} /></span>}
                </div>
                <h2 title={selected.name}>{selected.name}</h2>
                <div className="files-inspector-meta">
                  <div><b>Type</b><span>{selected.isDirectory ? 'Folder' : selected.kind}</span></div>
                  <div><b>Size</b><span>{humanFileSize(selected.sizeBytes)}</span></div>
                  <div><b>Modified</b><span>{dateLabel(selected.modifiedMs)}</span></div>
                  <div><b>Path</b><span className="files-path-text">{selected.path}</span></div>
                  {selected.isSymlink ? <div><b>Link</b><span>Filesystem link</span></div> : null}
                  {selected.isReadOnly ? <div><b>Access</b><span>Read-only</span></div> : null}
                </div>
                <button type="button" className="btn primary"
                  disabled={!selected.isDirectory && !canOpenInDefaultApp(selected)}
                  onClick={() => void activate(selected)}>
                  {selected.isDirectory ? 'Browse folder'
                    : canOpenInDefaultApp(selected) ? 'Open in default app' : 'Open via Explorer'}
                </button>
                {!selected.isDirectory && !canOpenInDefaultApp(selected) ? (
                  <p className="files-inspector-note">
                    This file type may execute code or use an untrusted association. Use Explorer fallback to open it deliberately.
                  </p>
                ) : null}
                <button type="button" className="btn" onClick={() => beginEdit('rename')}>
                  {Icon.edit({ size: 15 })} Rename
                </button>
                <p className="files-inspector-note">No delete or bulk move commands in this release. The Constellation is a view, not a new storage system.</p>
              </>
            ) : (
              <div className="files-inspector-idle">
                <span>{Icon.sparkle({ size: 32 })}</span>
                <h2>Select a file or star</h2>
                <p>Explore its real path, preview images, open it, or rename it.</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
