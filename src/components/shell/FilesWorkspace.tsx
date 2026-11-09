import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canOpenInDefaultApp, canPreview, createDirectory, filesAvailable, getPreviewUrl, listDirectory,
  listLocations, openFile, renameFile,
  type DirectoryListing, type FileEntry, type FileKind, type FileLocation,
} from '../../bridge/files';
import { runRecoveryAction } from '../../bridge/shellRecovery';
import { filterAndSortFiles, humanFileSize, makeFileStars, type FileSort } from '../../core/shell/fileMap';
import { fileBreadcrumbs } from '../../core/shell/fileNavigation';
import {
  readSpatialBookmarks, removeSpatialBookmark, saveSpatialBookmark,
  sameFolderPath, writeSpatialBookmarks,
  type SpatialBookmark, type SpatialCamera,
} from '../../core/shell/fileBookmarks';
import { Icon } from '../icons';
import { FileConstellation } from './FileConstellation';
import { FileInspector } from './FileInspector';
import { useStudio } from '../../state/store';
import type { FileFxMode } from '../../state/appSettings';
import '../../styles/files.css';
import '../../styles/files-spatial.css';

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

 function folderLabel(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function getBookmarkStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

export function FilesWorkspace() {
  const native = filesAvailable();
  const fxMode = useStudio((state) => state.appSettings.fileFxMode ?? 'cinematic');
  const updateAppSettings = useStudio((state) => state.updateAppSettings);
  const [locations, setLocations] = useState<FileLocation[]>([]);
  const [bookmarks, setBookmarks] = useState<SpatialBookmark[]>(() =>
    readSpatialBookmarks(getBookmarkStorage()));
  const [cameraRequest, setCameraRequest] = useState<{
    id: number; folderPath: string; camera: SpatialCamera;
  } | null>(null);
  const cameraRequestId = useRef(0);
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
  const breadcrumbs = useMemo(() => fileBreadcrumbs(listing?.path ?? ''), [listing?.path]);
  const currentBookmarked = !!listing && bookmarks.some((item) =>
    sameFolderPath(item.folderPath, listing.path));

  const saveView = (camera: SpatialCamera | null = null) => {
    if (!listing) return;
    const previous = bookmarks.find((item) => sameFolderPath(item.folderPath, listing.path));
    const next = saveSpatialBookmark(
      bookmarks, listing.path, folderLabel(listing.path),
      camera ?? previous?.camera ?? null, Date.now(),
    );
    if (!writeSpatialBookmarks(getBookmarkStorage(), next)) {
      setError('Could not save view locally. Your files are unchanged.');
      return;
    }
    setBookmarks(next);
    setNotice(camera ? 'Spatial view and camera saved on this device.' : 'Folder bookmarked on this device.');
    setError(null);
  };

  const restoreView = (bookmark: SpatialBookmark) => {
    setMode('constellation');
    setSelectedPath(null);
    if (bookmark.camera) {
      setCameraRequest({
        id: ++cameraRequestId.current,
        folderPath: bookmark.folderPath,
        camera: bookmark.camera,
      });
    } else {
      setCameraRequest(null);
    }
    navigate(bookmark.folderPath);
  };

  const removeView = (id: string) => {
    const next = removeSpatialBookmark(bookmarks, id);
    if (!writeSpatialBookmarks(getBookmarkStorage(), next)) {
      setError('Could not update local bookmarks.');
      return;
    }
    setBookmarks(next);
    setNotice('Saved view removed. No folders or files were deleted.');
  };

  const copyPath = async (path: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable in this environment.');
      await navigator.clipboard.writeText(path);
      setNotice('Path copied to clipboard.');
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

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
        <div className={`files-layout ${inspectorOpen ? 'files-inspector-open' : ''}`}>
          <aside className="files-places" aria-label="Places and drives">
            <h2>Places</h2>
            {locations.filter((place) => place.kind !== 'drive').map((place) => (
              <button key={place.path} className={listing?.path === place.path ? 'active' : ''}
                type="button" title={place.path} onClick={() => navigate(place.path)}>
                {place.kind === 'home' ? Icon.home({ size: 16 }) : Icon.folder({ size: 16 })}
                <span>{place.label}</span>
              </button>
            ))}
            <h2>Saved views <span className="files-saved-count">{bookmarks.length}</span></h2>
            {bookmarks.length ? (
              <div className="files-saved-views">
                {bookmarks.map((bookmark) => (
                  <div className="files-saved-item" key={bookmark.id}>
                    <button type="button" className="files-saved-link"
                      title={bookmark.folderPath} onClick={() => restoreView(bookmark)}>
                      {Icon.sparkle({ size: 15 })}
                      <span>{bookmark.label}</span>
                      {bookmark.camera ? <small>3D</small> : null}
                    </button>
                    <button type="button" className="files-saved-remove"
                      title={'Remove saved view ' + bookmark.label}
                      aria-label={'Remove saved view ' + bookmark.label}
                      onClick={() => removeView(bookmark.id)}>{Icon.close({ size: 12 })}</button>
                  </div>
                ))}
              </div>
            ) : <p className="files-saved-empty">Save a folder or camera angle to return here later.</p>}
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
            {listing && breadcrumbs.length ? <nav className="files-breadcrumbs"
              aria-label="Current folder hierarchy">
              {breadcrumbs.map((crumb, index) => (
                <span className="files-breadcrumb-node" key={crumb.path}>
                  {index > 0 ? <span className="files-breadcrumb-separator" aria-hidden="true">›</span> : null}
                  <button type="button" title={crumb.path}
                    aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}
                    disabled={busy || index === breadcrumbs.length - 1}
                    onClick={() => navigate(crumb.path)}>{crumb.label}</button>
                </span>
              ))}
            </nav> : null}

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
              {mode === 'constellation' ? (
                <label className="files-fx-select" title="Particle atmosphere quality. Kept separate from creative workflow effects.">
                  <span>Particle FX</span>
                  <select aria-label="Constellation particle effects"
                    value={fxMode}
                    onChange={(event) => updateAppSettings({ fileFxMode: event.target.value as FileFxMode })}>
                    <option value="off">Off</option>
                    <option value="balanced">Balanced</option>
                    <option value="cinematic">Cinematic</option>
                  </select>
                </label>
              ) : null}
              <button className="btn files-bookmark-button" type="button"
                title={currentBookmarked ? 'Update the saved folder bookmark' : 'Save this folder on this device'}
                disabled={!listing || loading}
                onClick={() => saveView()}>
                {Icon.save({ size: 15 })} {currentBookmarked ? 'Saved folder' : 'Bookmark'}
              </button>
              <button className="btn files-inspector-toggle" type="button"
                aria-controls="files-inspector-panel" aria-expanded={inspectorOpen}
                onClick={() => setInspectorOpen((value) => !value)}>
                {Icon.target({ size: 15 })} Inspector
              </button>
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
                    fxMode={fxMode}
                    folderPath={listing.path}
                    folderName={folderLabel(listing.path)}
                    cameraRequest={cameraRequest}
                    onSaveView={(camera) => saveView(camera)}
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

          <FileInspector
            selected={selected}
            listing={listing}
            onClose={() => setInspectorOpen(false)}
            onOpen={(entry) => { void activate(entry); }}
            onRename={() => beginEdit('rename')}
            onCopyPath={(path) => { void copyPath(path); }}
            onSelectRelated={(entry) => setSelectedPath(entry.path)}
          />
        </div>
      )}
    </main>
  );
}
