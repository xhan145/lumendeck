import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { runRecoveryAction } from '../../bridge/shellRecovery';
import { useStudio, type ViewId } from '../../state/store';
import { Icon } from '../icons';

type LauncherItem =
  | { kind: 'view'; id: ViewId; label: string; description: string; keywords: string; icon: () => React.ReactNode }
  | { kind: 'recovery'; id: 'explorer' | 'task-manager'; label: string; description: string; keywords: string; icon: () => React.ReactNode };

const ITEMS: LauncherItem[] = [
  { kind: 'view', id: 'desktop', label: 'Desktop', description: 'Return to the LumenDeck desktop.', keywords: 'home desktop shell', icon: () => Icon.home({ size: 19 }) },
  { kind: 'view', id: 'files', label: 'Files', description: 'Browse Windows files inside LumenDeck.', keywords: 'files folders drives constellation', icon: () => Icon.folder({ size: 19 }) },
  { kind: 'recovery', id: 'explorer', label: 'Windows Explorer (fallback)', description: 'Launch the original Windows file manager.', keywords: 'explorer fallback recovery files', icon: () => Icon.folder({ size: 19 }) },
  { kind: 'view', id: 'controls', label: 'Create', description: 'Open generation controls.', keywords: 'create render generate controls', icon: () => Icon.play({ size: 19 }) },
  { kind: 'view', id: 'projects', label: 'Projects', description: 'Open creative projects.', keywords: 'projects work', icon: () => Icon.layers({ size: 19 }) },
  { kind: 'view', id: 'gallery', label: 'Gallery', description: 'Browse rendered media.', keywords: 'gallery images video media', icon: () => Icon.image({ size: 19 }) },
  { kind: 'view', id: 'mission', label: 'Creative Studio', description: 'Open project command tools.', keywords: 'studio mission creative', icon: () => Icon.compass({ size: 19 }) },
  { kind: 'view', id: 'graph', label: 'Graph', description: 'Edit generation workflows.', keywords: 'graph workflow nodes', icon: () => Icon.graph({ size: 19 }) },
  { kind: 'view', id: 'shelf', label: 'Model Shelf', description: 'Manage local models and LoRAs.', keywords: 'model shelf lora', icon: () => Icon.grid({ size: 19 }) },
  { kind: 'view', id: 'settings', label: 'Settings', description: 'Open shell and app settings.', keywords: 'settings shell startup privacy', icon: () => Icon.gear({ size: 19 }) },
  { kind: 'view', id: 'diagnostics', label: 'Diagnostics', description: 'Check health and recovery information.', keywords: 'diagnostics health errors recovery', icon: () => Icon.pulse({ size: 19 }) },
  { kind: 'recovery', id: 'task-manager', label: 'Task Manager', description: 'Open Windows Task Manager.', keywords: 'task manager recovery processes', icon: () => Icon.pulse({ size: 19 }) },
];

export function ShellLauncher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setView = useStudio((s) => s.setView);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const normalized = query.trim().toLowerCase();
  const items = useMemo(() => {
    if (!normalized) return ITEMS;
    return ITEMS.filter((item) =>
      `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalized),
    );
  }, [normalized]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setStatus(null);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Enter' && items[0]) {
        event.preventDefault();
        void activate(items[0]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, items]);

  const activate = async (item: LauncherItem) => {
    if (item.kind === 'view') {
      setView(item.id);
      onClose();
      return;
    }
    try {
      await runRecoveryAction(item.id);
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  if (!open) return null;

  return (
    <div className="shell-launcher-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="shell-launcher" role="dialog" aria-modal="true" aria-label="LumenDeck launcher">
        <label className="shell-launcher-search">
          <span aria-hidden="true">{Icon.target({ size: 18 })}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search LumenDeck..."
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </label>
        <div className="shell-launcher-results" role="listbox" aria-label="Launcher results">
          {items.map((item) => (
            <button key={`${item.kind}:${item.id}`} type="button" className="shell-launcher-item" onClick={() => void activate(item)}>
              <span className="shell-launcher-icon">{item.icon()}</span>
              <span><b>{item.label}</b><small>{item.description}</small></span>
            </button>
          ))}
          {items.length === 0 ? <p className="shell-launcher-empty">No matching command.</p> : null}
        </div>
        <footer className="shell-launcher-foot">
          <span>Ctrl + Space opens this launcher</span>
          {status ? <span className="shell-launcher-error" role="status">{status}</span> : null}
        </footer>
      </section>
    </div>
  );
}
