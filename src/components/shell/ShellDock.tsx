import { useEffect, useState } from 'react';
import { runRecoveryAction } from '../../bridge/shellRecovery';
import { useStudio } from '../../state/store';
import { BrandMark, Icon } from '../icons';

export function ShellDock({ onOpenLauncher }: { onOpenLauncher: () => void }) {
  const setView = useStudio((s) => s.setView);
  const [clock, setClock] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const openFiles = async () => {
    setError(null);
    try {
      await runRecoveryAction('explorer');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <nav className="shell-dock" aria-label="Desktop taskbar">
        <button className="shell-dock-brand" type="button" aria-label="LumenDeck Desktop" onClick={() => setView('desktop')}>
          <BrandMark size={24} />
        </button>
        <button type="button" onClick={onOpenLauncher} title="Search and commands (Ctrl + Space)">
          {Icon.target({ size: 19 })}<span>Search</span>
        </button>
        <button type="button" onClick={() => void openFiles()} title="Open Files">
          {Icon.folder({ size: 19 })}<span>Files</span>
        </button>
        <button type="button" onClick={() => setView('controls')} title="Create">
          {Icon.play({ size: 19 })}<span>Create</span>
        </button>
        <button type="button" onClick={() => setView('mission')} title="Creative Studio">
          {Icon.compass({ size: 19 })}<span>Studio</span>
        </button>
        <span className="shell-dock-spacer" />
        <button type="button" onClick={() => setView('settings')} title="Settings">
          {Icon.gear({ size: 19 })}<span className="shell-dock-label-optional">Settings</span>
        </button>
        <time className="shell-dock-clock" dateTime={clock.toISOString()}>
          <span>{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <small>{clock.toLocaleDateString([], { month: 'short', day: 'numeric' })}</small>
        </time>
      </nav>
      {error ? (
        <button className="shell-dock-toast" type="button" onClick={() => setView('diagnostics')}>
          Files could not open. Open Diagnostics.
        </button>
      ) : null}
    </>
  );
}
