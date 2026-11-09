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
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  const normalized = query.trim().toLowerCase();
  const items = useMemo(() => {
    if (!normalized) return ITEMS;
    return ITEMS.filter((item) =>
      `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalized),
    );
  }, [normalized]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setStatus(null);
    setActiveIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

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

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => items.length ? (index + 1) % items.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => items.length ? (index + items.length - 1) % items.length : 0);
    } else if (event.key === 'Enter' && items[activeIndex]) {
      event.preventDefault();
      void activate(items[activeIndex]);
    }
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled])',
    ));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <div className="shell-launcher-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="shell-launcher" role="dialog" aria-modal="true"
        aria-label="LumenDeck launcher" onKeyDown={onDialogKeyDown}>
        <label className="shell-launcher-search">
          <span aria-hidden="true">{Icon.target({ size: 18 })}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search LumenDeck..."
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </label>
        <div className="shell-launcher-results" role="group" aria-label="Launcher results">
          {items.map((item, index) => (
            <button key={`${item.kind}:${item.id}`} type="button"
              className={`shell-launcher-item ${index === activeIndex ? 'active' : ''}`}
              onClick={() => void activate(item)}>
              <span className="shell-launcher-icon">{item.icon()}</span>
              <span><b>{item.label}</b><small>{item.description}</small></span>
            </button>
          ))}
          {items.length === 0 ? <p className="shell-launcher-empty">No matching command.</p> : null}
        </div>
        <footer className="shell-launcher-foot">
          <span>Ctrl + Space · ↑/↓ selects · Enter opens · Esc closes</span>
          {status ? <span className="shell-launcher-error" role="status">{status}</span> : null}
        </footer>
      </section>
    </div>
  );
}
