import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SHELL_ACTIONS,
  shellActionBroker,
  type ActionAuditEntry,
} from '../core/shell/actions';
import { shellWorkflowRunner } from '../core/shell/automation';
import type { ShellWindowInfo } from '../core/shell/client';

export function ShellRuntimePage() {
  const [windows, setWindows] = useState<ShellWindowInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('Ready');
  const [audit, setAudit] = useState<ActionAuditEntry[]>([]);

  const syncAudit = useCallback(() => {
    setAudit(shellActionBroker.audit.slice(-16).reverse());
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
      setStatus(`Found ${result.length} user-facing windows.`);
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

  const runWindowAction = async (
    action: typeof SHELL_ACTIONS.focusWindow,
    handle: string,
    label: string,
  ) => {
    setBusy(true);
    try {
      await shellActionBroker.run(action, { handle }, { source: 'user' });
      setStatus(label);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      syncAudit();
      setBusy(false);
    }
  };

  const focusAndMaximize = async (item: ShellWindowInfo) => {
    setBusy(true);
    try {
      const result = await shellWorkflowRunner.run({
        id: `focus-maximize-${item.handle}`,
        name: `Focus and maximize ${item.title}`,
        version: 1,
        steps: [
          { id: 'focus', action: 'window.focus', args: { handle: item.handle } },
          { id: 'maximize', action: 'window.maximize', args: { handle: item.handle } },
        ],
      });

      setStatus(result.ok
        ? `Automation complete: focused and maximized ${item.title}`
        : `Automation stopped at ${result.stoppedAt ?? 'unknown step'}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      syncAudit();
      setBusy(false);
    }
  };

  const closeWindow = async (item: ShellWindowInfo) => {
    const approved = window.confirm(`Ask ${item.title} to close? Unsaved work may prompt inside that app.`);
    if (!approved) return;

    setBusy(true);
    try {
      await shellActionBroker.run(
        SHELL_ACTIONS.closeWindow,
        { handle: item.handle },
        { source: 'user', approved: true },
      );
      setStatus(`Close requested: ${item.title}`);
      window.setTimeout(() => void refresh(), 350);
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
              Non-destructive developer surface for LumenDeck shell primitives and
              brokered automation. Explorer remains the active Windows shell.
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
            {windows.length === 0 ? (
              <p className="field-help">No user-facing windows returned yet.</p>
            ) : windows.map((item) => (
              <div key={item.handle} className="field">
                <span className="field-label">{item.title}</span>
                <span className="field-help">PID {item.processId} · HWND {item.handle}</span>
                <div className="control-button-grid">
                  <button className="btn" type="button" disabled={busy}
                    onClick={() => void runWindowAction(SHELL_ACTIONS.focusWindow, item.handle, `Focused: ${item.title}`)}>
                    Focus
                  </button>
                  <button className="btn" type="button" disabled={busy}
                    onClick={() => void runWindowAction(SHELL_ACTIONS.minimizeWindow, item.handle, `Minimized: ${item.title}`)}>
                    Minimize
                  </button>
                  <button className="btn" type="button" disabled={busy}
                    onClick={() => void runWindowAction(SHELL_ACTIONS.restoreWindow, item.handle, `Restored: ${item.title}`)}>
                    Restore
                  </button>
                  <button className="btn" type="button" disabled={busy}
                    onClick={() => void focusAndMaximize(item)}>
                    Focus + Maximize
                  </button>
                  <button className="btn" type="button" disabled={busy}
                    onClick={() => void closeWindow(item)}>
                    Close…
                  </button>
                </div>
              </div>
            ))}
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Automation</h2>
              <span className="chip clean">Deterministic</span>
            </div>
            <p className="field-help">
              Multi-step workflows run sequentially through the same Action Broker as manual
              controls. Unknown actions are rejected before execution, stateful actions require
              approval, and hard-denied risk classes cannot be overridden by a workflow.
            </p>
            <dl>
              <dt>Focus + Maximize</dt><dd>2 reversible actions · automatic</dd>
              <dt>Close</dt><dd>stateful · explicit approval required</dd>
              <dt>Destructive / security-sensitive</dt><dd>denied</dd>
            </dl>
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
              <dt>window.list / isAlive</dt><dd>window.read · allow</dd>
              <dt>focus / minimize / maximize / restore</dt><dd>window.control · allow</dd>
              <dt>window.close</dt><dd>window.control · ask</dd>
              <dt>recovery.explorer.launch</dt><dd>recovery.explorer · allow</dd>
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
                    {entry.actionId} · {entry.source} · {entry.capability} · {entry.risk}
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
