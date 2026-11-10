import { useMemo, useState } from 'react';
import type React from 'react';
import { runRecoveryAction, type RecoveryAction } from '../../bridge/shellRecovery';
import { useStudio, type ViewId } from '../../state/store';
import { Icon } from '../icons';

interface Destination {
  id: ViewId;
  label: string;
  description: string;
  keywords: string;
  icon: () => React.ReactNode;
}

const PRIMARY: Destination[] = [
  { id: 'files', label: 'Files', description: 'Browse real folders or navigate them as a 3D Constellation.', keywords: 'files folders explorer constellation drives browse', icon: () => Icon.folder({ size: 22 }) },
  { id: 'projects', label: 'Projects', description: 'Open and manage active creative work.', keywords: 'projects work recent', icon: () => Icon.layers({ size: 22 }) },
  { id: 'gallery', label: 'Gallery', description: 'Browse renders and exported media.', keywords: 'gallery images video renders media', icon: () => Icon.image({ size: 22 }) },
  { id: 'controls', label: 'Create', description: 'Jump directly into generation controls.', keywords: 'create controls render generate', icon: () => Icon.play({ size: 22 }) },
];

const TOOLS: Destination[] = [
  { id: 'mission', label: 'Creative Studio', description: 'Projects, readiness, next actions, and release work.', keywords: 'studio creative mission projects', icon: () => Icon.compass({ size: 20 }) },
  { id: 'graph', label: 'Graph', description: 'Build and edit generation workflows.', keywords: 'graph workflow nodes', icon: () => Icon.graph({ size: 20 }) },
  { id: 'shelf', label: 'Model Shelf', description: 'Models, LoRAs, and local assets.', keywords: 'models lora shelf assets', icon: () => Icon.grid({ size: 20 }) },
  { id: 'recipes', label: 'Recipes', description: 'Reusable creative workflows.', keywords: 'recipes templates workflows', icon: () => Icon.beaker({ size: 20 }) },
  { id: 'constellation', label: 'Constellation', description: 'Explore the visual workflow universe.', keywords: 'constellation universe visual', icon: () => Icon.logo({ size: 20 }) },
  { id: 'overview', label: 'Studio Overview', description: 'Portfolio-level project status.', keywords: 'overview portfolio status', icon: () => Icon.target({ size: 20 }) },
  { id: 'craft', label: 'Craft Insights', description: 'Patterns and guidance across your work.', keywords: 'craft insights guidance', icon: () => Icon.sparkle({ size: 20 }) },
  { id: 'entropy', label: 'Entropy', description: 'Find disorder and cleanup opportunities.', keywords: 'entropy cleanup disorder', icon: () => Icon.scatter({ size: 20 }) },
  { id: 'proof', label: 'Proof', description: 'Review shipped artifacts and evidence.', keywords: 'proof shipped exports', icon: () => Icon.trophy({ size: 20 }) },
  { id: 'guide', label: 'Guide', description: 'Learn the current creative workflow.', keywords: 'guide help learn', icon: () => Icon.help({ size: 20 }) },
];

const SYSTEM: Destination[] = [
  { id: 'settings', label: 'Settings', description: 'Startup, paths, privacy, and shell preferences.', keywords: 'settings startup privacy shell', icon: () => Icon.gear({ size: 20 }) },
  { id: 'diagnostics', label: 'Diagnostics', description: 'Check health and recover from problems.', keywords: 'diagnostics errors recovery health', icon: () => Icon.pulse({ size: 20 }) },
  { id: 'performance', label: 'Performance', description: 'Hardware, acceleration, and resource controls.', keywords: 'performance hardware gpu acceleration', icon: () => Icon.bolt({ size: 20 }) },
  { id: 'support', label: 'Support', description: 'Help and troubleshooting resources.', keywords: 'support help troubleshoot', icon: () => Icon.heart({ size: 20 }) },
];

export function DesktopHome() {
  const setView = useStudio((s) => s.setView);
  const bridgeOnline = useStudio((s) => s.bridgeOnline);
  const adapterId = useStudio((s) => s.adapterId);
  const health = useStudio((s) => s.health);
  const projects = useStudio((s) => s.creative.brains);
  const gallery = useStudio((s) => s.gallery);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState<RecoveryAction | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);

  const issues = health.filter((item) => item.severity === 'error').length;
  const normalized = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!normalized) return [];
    return [...PRIMARY, ...TOOLS, ...SYSTEM].filter((item) =>
      `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalized),
    );
  }, [normalized]);

  const backendLabel = adapterId === 'mock' ? 'Built-in mode' : bridgeOnline ? 'Local backend ready' : 'Local backend offline';

  const recover = async (action: RecoveryAction) => {
    setRecoveryBusy(action);
    setRecoveryStatus(null);
    try {
      await runRecoveryAction(action);
      setRecoveryStatus(action === 'explorer' ? 'Windows Explorer launched.' : 'Task Manager launched.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRecoveryStatus(`Recovery action failed: ${message}`);
    } finally {
      setRecoveryBusy(null);
    }
  };

  return (
    <main className="desktop-home scroll" aria-label="LumenDeck Desktop">
      <div className="desktop-home-inner">
        <header className="desktop-hero">
          <div>
            <p className="page-kicker">LumenDeck Desktop</p>
            <h1>Your workspace, not a control panel.</h1>
            <p>Open files, create, switch into studio tools, or recover Windows without learning LumenDeck's internal architecture.</p>
          </div>
          <button className="btn icon" type="button" aria-label="Open settings" onClick={() => setView('settings')}>
            {Icon.gear({ size: 19 })}
          </button>
        </header>

        <label className="desktop-search">
          <span className="vh">Search LumenDeck</span>
          <span aria-hidden="true">{Icon.target({ size: 18 })}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools, projects, gallery, settings..."
            autoComplete="off"
          />
        </label>

        {normalized ? (
          <section className="desktop-search-results" aria-live="polite">
            <div className="desktop-section-head">
              <h2>Results</h2>
              <span>{searchResults.length}</span>
            </div>
            {searchResults.length ? (
              <div className="desktop-tool-grid">
                {searchResults.map((item) => (
                  <button key={item.id} type="button" className="desktop-tool" onClick={() => setView(item.id)}>
                    <span className="desktop-tool-icon">{item.icon()}</span>
                    <span><b>{item.label}</b><small>{item.description}</small></span>
                  </button>
                ))}
              </div>
            ) : <p className="desktop-empty">No matching LumenDeck tools.</p>}
          </section>
        ) : (
          <>
            <section>
              <div className="desktop-section-head">
                <h2>Start here</h2>
                <span>{projects.length} projects · {gallery.length} renders</span>
              </div>
              <div className="desktop-primary-grid">
                {PRIMARY.map((item) => (
                  <button key={item.id} type="button" className="desktop-primary-card" onClick={() => setView(item.id)}>
                    <span className="desktop-primary-icon">{item.icon()}</span>
                    <span className="desktop-primary-copy"><b>{item.label}</b><small>{item.description}</small></span>
                    <span className="desktop-primary-go" aria-hidden="true">{Icon.play({ size: 13 })}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="desktop-status-strip" aria-label="System status">
              <button type="button" onClick={() => setView('diagnostics')}>
                <span className={issues ? 'desktop-status-dot problem' : 'desktop-status-dot'} aria-hidden="true" />
                <span><b>{issues ? `${issues} issue${issues === 1 ? '' : 's'} need attention` : 'System healthy'}</b><small>{backendLabel}</small></span>
              </button>
              <button type="button" onClick={() => setView('settings')}>
                {Icon.gear({ size: 18 })}
                <span><b>Shell & app settings</b><small>Startup, paths, performance, and privacy.</small></span>
              </button>
            </section>

            <section>
              <div className="desktop-section-head">
                <h2>More tools</h2>
                <button className="btn tiny" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
                  {showAll ? 'Hide' : 'Show all'}
                </button>
              </div>
              {showAll ? (
                <div className="desktop-tool-grid">
                  {TOOLS.map((item) => (
                    <button key={item.id} type="button" className="desktop-tool" onClick={() => setView(item.id)}>
                      <span className="desktop-tool-icon">{item.icon()}</span>
                      <span><b>{item.label}</b><small>{item.description}</small></span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="desktop-muted">Advanced creative tools stay out of the way until you ask for them.</p>
              )}
            </section>

            <section className="desktop-recovery">
              <div>
                <p className="page-kicker">Recovery</p>
                <h2>Never trap the desktop.</h2>
                <p>LumenDeck can launch Windows Explorer or Task Manager without exposing arbitrary command execution to the UI.</p>
                {recoveryStatus ? <p className="desktop-recovery-status" role="status">{recoveryStatus}</p> : null}
              </div>
              <div className="desktop-recovery-actions">
                <button className="btn" type="button" disabled={recoveryBusy !== null} onClick={() => void recover('explorer')}>
                  {Icon.folder({ size: 15 })} {recoveryBusy === 'explorer' ? 'Opening…' : 'Open Explorer'}
                </button>
                <button className="btn" type="button" disabled={recoveryBusy !== null} onClick={() => void recover('task-manager')}>
                  {Icon.pulse({ size: 15 })} {recoveryBusy === 'task-manager' ? 'Opening…' : 'Task Manager'}
                </button>
                <button className="btn" type="button" onClick={() => setView('diagnostics')}>{Icon.pulse({ size: 15 })} Diagnostics</button>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
