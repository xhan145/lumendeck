import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SHELL_ACTIONS,
  shellActionBroker,
  type ActionAuditEntry,
} from '../core/shell/actions';
import type { ShellWindowInfo } from '../core/shell/client';

export function ShellRuntimePage() {
  const [windows, setWindows] = useState<ShellWindowInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('Ready');
  const [audit, setAudit] = useState<ActionAuditEntry[]>([]);

  const syncAudit = useCallback(() => {
    setAudit(shellActionBroker.audit.slice(-12).reverse());
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await shellActionBroker.run(
        SHELL_ACTIONS.listWindows,
        undefined,
        { source: 'user' },
      );
      setWindows(result);
      setStatus(`Found ${result.length} top-level windows.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      syncAudit();
      setBusy(false);
    }
  }, [syncAudit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleCount = useMemo(
    () => windows.filter((item) => item.visible).length,
    [windows],
  );

  const focus = async (handle: string, title: string) => {
    setBusy(true);
    try {
      await shellActionBroker.run(
        SHELL_ACTIONS.focusWindow,
        { handle },
        { source: 'user' },
      );
      setStatus(`Focused: ${title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      syncAudit();
      setBusy(false);
    }
  };

  const launchExplorer = async () => {
    setBusy(true);
    try {
      await shellActionBroker.run(
        SHELL_ACTIONS.launchExplorer,
        undefined,
        { source: 'user' },
      );
      setStatus('Explorer launch requested.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      syncAudit();
      setBusy(false);
    }
  };

  return (
    <main className="studio-page scroll" aria-label="Shell Runtime">
      <div className="studio-page-inner">
        <header className="page-hero">
          <div>
            <p className="page-kicker">Shell Runtime</p>
            <h1>Windows Control Plane</h1>
            <p>
              Non-destructive developer surface for LumenDeck shell primitives.
              Explorer remains the active Windows shell.
            </p>
          </div>
          <div className="page-hero-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>
              Refresh windows
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void launchExplorer()}>
              Launch Explorer
            </button>
          </div>
        </header>

        <div className="status-banner" role="status">{status}</div>

        <section className="page-grid">
          <article className="card page-card">
            <div className="page-card-head">
              <h2>Window inventory</h2>
              <span className="chip">{visibleCount} visible / {windows.length} total</span>
            </div>
            <div className="control-button-grid">
              {windows.length === 0 ? (
                <p className="field-help">No windows returned yet.</p>
              ) : windows.map((item) => (
                <button
                  className="btn"
                  type="button"
                  key={item.handle}
                  disabled={busy}
                  onClick={() => void focus(item.handle, item.title)}
                  title={`PID ${item.processId} · HWND ${item.handle}`}
                >
                  {item.visible ? '●' : '○'} {item.title}
                </button>
              ))}
            </div>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Action policy</h2>
              <span className="chip clean">Guarded</span>
            </div>
            <p className="field-help">
              Read-only and reversible shell actions are allowed. Stateful actions require
              explicit approval. Destructive and security-sensitive actions are denied.
            </p>
            <dl>
              <dt>window.list</dt><dd>read-only · allow</dd>
              <dt>window.focus</dt><dd>reversible · allow</dd>
              <dt>recovery.explorer.launch</dt><dd>reversible · allow</dd>
            </dl>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Recent action audit</h2>
              <span className="chip">{audit.length}</span>
            </div>
            {audit.length === 0 ? (
              <p className="field-help">No shell actions recorded this session.</p>
            ) : (
              <div>
                {audit.map((entry) => (
                  <p className="field-help" key={entry.id}>
                    <strong>{entry.ok ? 'OK' : 'BLOCKED'}</strong>{' '}
                    {entry.actionId} · {entry.source} · {entry.risk}
                    {entry.error ? ` · ${entry.error}` : ''}
                  </p>
                ))}
              </div>
            )}
          </article>
        </section>
      </div>
    </main>
  );
}
