import { useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../../state/storeConstants';
import { Icon } from '../icons';
import {
  checkForUpdate,
  downloadAndInstall,
  isTauri,
  relaunch,
  type UpdateProgress,
} from '../../bridge/updater';
import '../../styles/updates.css';

/**
 * In-app auto-updater card.
 *
 * States: idle → checking → up-to-date / available(version+notes) →
 * downloading(progress) → ready → Relaunch, plus a loud error state. Runs one
 * silent check on mount (desktop only; dismissible, no nagging). In the browser
 * it shows a disabled "Desktop app only" note and never calls the plugins.
 */
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; version: string; fraction?: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

export function UpdatesCard() {
  const desktop = isTauri();
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const autoChecked = useRef(false);

  // One silent check on mount (desktop only). `autoChecked` guards against the
  // React 18 StrictMode double-invoke so we never fire two checks.
  useEffect(() => {
    if (!desktop || autoChecked.current) return;
    autoChecked.current = true;
    let cancelled = false;
    void (async () => {
      const result = await checkForUpdate();
      if (cancelled) return;
      if (result.error) {
        // A silent, on-mount failure stays quiet — the user can retry with Check.
        return;
      }
      if (result.available && result.version) {
        setState({ kind: 'available', version: result.version, notes: result.notes });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const runCheck = async () => {
    setDismissed(false);
    setState({ kind: 'checking' });
    const result = await checkForUpdate();
    if (result.error) {
      setState({ kind: 'error', message: result.error });
      return;
    }
    if (result.available && result.version) {
      setState({ kind: 'available', version: result.version, notes: result.notes });
    } else {
      setState({ kind: 'up-to-date' });
    }
  };

  const runInstall = async (version: string) => {
    setState({ kind: 'downloading', version, fraction: undefined });
    const result = await downloadAndInstall((progress: UpdateProgress) => {
      if (progress.phase === 'downloading') {
        setState({ kind: 'downloading', version, fraction: progress.fraction });
      }
    });
    if (result.error) {
      setState({ kind: 'error', message: result.error });
      return;
    }
    setState({ kind: 'ready', version });
  };

  const runRelaunch = async () => {
    const result = await relaunch();
    // Success replaces the process, so we only get here on failure.
    if (result.error) setState({ kind: 'error', message: result.error });
  };

  const busy = state.kind === 'checking' || state.kind === 'downloading';
  const showAuto = state.kind === 'available' && !dismissed;

  return (
    <article className="card page-card updates-card">
      <div className="page-card-head">
        <h2>Updates</h2>
        <span className="chip">v{APP_VERSION}</span>
      </div>

      {!desktop ? (
        <>
          <p className="field-help">
            Automatic updates run only in the installed desktop app. This web/dev preview does not
            self-update.
          </p>
          <div className="control-button-grid">
            <button className="btn" type="button" disabled aria-disabled="true">
              {Icon.download({ size: 16 })} Desktop app only
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="field-help">
            LumenDeck checks GitHub Releases for a newer signed build and can install it in place.
          </p>

          <div className="updates-status" role="status" aria-live="polite">
            {state.kind === 'idle' && (
              <span className="updates-line">Ready to check for updates.</span>
            )}
            {state.kind === 'checking' && (
              <span className="updates-line">{Icon.pulse({ size: 16 })} Checking for updates…</span>
            )}
            {state.kind === 'up-to-date' && (
              <span className="updates-line ok">
                {Icon.ok({ size: 16 })} You are on the latest version.
              </span>
            )}
            {state.kind === 'available' && (
              <div className="updates-available">
                <div className="updates-available-head">
                  <span className="updates-line accent">
                    {Icon.download({ size: 16 })} Update available — v{state.version}
                  </span>
                  {showAuto && (
                    <button
                      className="btn icon updates-dismiss"
                      type="button"
                      aria-label="Dismiss update notice"
                      onClick={() => setDismissed(true)}
                    >
                      {Icon.close({ size: 14 })}
                    </button>
                  )}
                </div>
                {state.notes ? <p className="updates-notes">{state.notes}</p> : null}
              </div>
            )}
            {state.kind === 'downloading' && (
              <div className="updates-downloading">
                <span className="updates-line">
                  {Icon.download({ size: 16 })} Downloading v{state.version}…
                </span>
                <div
                  className="progress updates-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    state.fraction === undefined ? undefined : Math.round(state.fraction * 100)
                  }
                >
                  <div
                    style={{ width: state.fraction === undefined ? '35%' : `${Math.round(state.fraction * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {state.kind === 'ready' && (
              <span className="updates-line ok">
                {Icon.ok({ size: 16 })} v{state.version} installed — relaunch to finish.
              </span>
            )}
            {state.kind === 'error' && (
              <span className="updates-line error updates-error" role="alert">
                {Icon.error({ size: 16 })} Update failed: {state.message}
              </span>
            )}
          </div>

          <div className="control-button-grid">
            <button className="btn" type="button" onClick={() => void runCheck()} disabled={busy}>
              {Icon.pulse({ size: 16 })} Check for updates
            </button>
            {state.kind === 'available' && (
              <button
                className="btn primary"
                type="button"
                onClick={() => void runInstall(state.version)}
              >
                {Icon.download({ size: 16 })} Download & install
              </button>
            )}
            {state.kind === 'ready' && (
              <button className="btn primary" type="button" onClick={() => void runRelaunch()}>
                {Icon.pulse({ size: 16 })} Relaunch now
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}
