import { useEffect } from 'react';
import { useStudio, type ViewId } from './state/store';
import { BackendSettingsPanel } from './components/BackendSettingsPanel';
import { TurboForgePanel } from './components/TurboForgePanel';
import { Gallery } from './components/gallery/Gallery';
import { GraphView } from './components/graph/GraphView';
import { HealthPanel } from './components/health/HealthPanel';
import { Icon } from './components/icons';
import { Inspector } from './components/inspector/Inspector';
import { LoraRack } from './components/rack/LoraRack';
import { ModelShelf } from './components/shelf/ModelShelf';
import { QueuePanel } from './components/queue/QueuePanel';
import { RecipeView } from './components/recipe/RecipeView';
import './styles/base.css';
import './styles/app.css';

const TABS: { id: ViewId; label: string }[] = [
  { id: 'recipe', label: 'Recipe View' },
  { id: 'graph', label: 'Graph View' },
  { id: 'shelf', label: 'Model Shelf' },
  { id: 'gallery', label: 'Gallery' },
];

function HealthChip() {
  const health = useStudio((s) => s.health);
  const setView = useStudio((s) => s.setView);
  const errors = health.filter((i) => i.severity === 'error').length;
  const warnings = health.length - errors;
  const cls = errors > 0 ? 'errors' : warnings > 0 ? 'warnings' : 'clean';
  const label = errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'Healthy';
  return (
    <button className={`chip health-chip ${cls}`} type="button" onClick={() => setView('graph')} title="Open Graph Health">
      {errors > 0 ? Icon.error({ size: 14 }) : warnings > 0 ? Icon.warning({ size: 14 }) : Icon.ok({ size: 14 })}
      {label}
    </button>
  );
}

function BridgeStatus() {
  const bridgeOnline = useStudio((s) => s.bridgeOnline);
  const adapterId = useStudio((s) => s.adapterId);
  return (
    <span className={`chip bridge-status ${bridgeOnline ? 'online' : ''}`} title="Local render backend status">
      <span className="dot" /> {adapterId === 'mock' ? 'Built-in' : bridgeOnline ? 'Backend online' : 'Backend offline'}
    </span>
  );
}

function RenderButton() {
  const health = useStudio((s) => s.health);
  const enqueueRender = useStudio((s) => s.enqueueRender);
  const errors = health.filter((i) => i.severity === 'error');
  const blocked = errors.length > 0;
  return (
    <section className="rail-section">
      <button className="btn primary" type="button" disabled={blocked} onClick={() => void enqueueRender()} style={{ width: '100%', justifyContent: 'center' }}>
        {Icon.play()} Render
      </button>
      {blocked ? (
        <p className="field-help" style={{ color: 'var(--ld-danger)', marginTop: 8 }}>
          Fix {errors.length} graph error{errors.length === 1 ? '' : 's'} before rendering.
        </p>
      ) : null}
    </section>
  );
}

function SideRail() {
  return (
    <aside className="side-rail" aria-label="Studio controls">
      <RenderButton />
      <div className="rail-scroll scroll">
        <section className="rail-section">
          <h3>Inspector</h3>
          <Inspector />
        </section>
        <BackendSettingsPanel />
        <TurboForgePanel />
        <LoraRack />
        <HealthPanel />
        <QueuePanel />
      </div>
    </aside>
  );
}

export function App() {
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  const probeBridge = useStudio((s) => s.probeBridge);

  // Probe the local bridge once on load so the shelf/status reflect reality.
  useEffect(() => { void probeBridge(); }, [probeBridge]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {Icon.logo({ size: 22 })}
          <span className="lumen">Lumen</span><span className="deck">Deck</span>
          <span className="ver">v0.1.0</span>
        </div>
        <nav className="tabs" aria-label="Primary views">
          {TABS.map((t) => (
            <button key={t.id} className="tab" type="button" aria-current={view === t.id} onClick={() => setView(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <BridgeStatus />
          <HealthChip />
        </div>
      </header>
      <div className="workspace">
        <div className="main-pane">
          {view === 'recipe' ? <RecipeView />
            : view === 'graph' ? <GraphView />
            : view === 'shelf' ? <ModelShelf />
            : <Gallery />}
        </div>
        <SideRail />
      </div>
    </div>
  );
}
