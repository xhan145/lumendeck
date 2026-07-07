import { useEffect } from 'react';
import { useStudio, type ViewId } from './state/store';
import { APP_VERSION } from './state/storeConstants';
import { Gallery } from './components/gallery/Gallery';
import { GuideView } from './components/guide/GuideView';
import { GraphWorkspace } from './components/graph/GraphWorkspace';
import { BrandMark, Icon } from './components/icons';
import { ModelShelf } from './components/shelf/ModelShelf';
import { NavRail } from './components/shell/NavRail';
import { RecipeView } from './components/recipe/RecipeView';
import { ControlsPage } from './pages/ControlsPage';
import { CreditsPage } from './pages/CreditsPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { PerformancePage } from './pages/PerformancePage';
import { SettingsPage } from './pages/SettingsPage';
import { SupportPage } from './pages/SupportPage';
import './styles/base.css';
import './styles/app.css';

const VIEW_TITLES: Record<ViewId, string> = {
  guide: 'Guide',
  recipe: 'Recipe',
  graph: 'Graph',
  shelf: 'Model Shelf',
  gallery: 'Gallery',
  controls: 'Controls',
  settings: 'Settings',
  diagnostics: 'Diagnostics',
  performance: 'Performance',
  support: 'Support',
  credits: 'Credits',
};

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

export function App() {
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  const probeBridge = useStudio((s) => s.probeBridge);
  const compactMode = useStudio((s) => s.appSettings.compactMode);

  useEffect(() => { void probeBridge(); }, [probeBridge]);

  const page =
    view === 'guide' ? <GuideView onOpenControls={() => setView('controls')} />
      : view === 'recipe' ? <RecipeView />
      : view === 'graph' ? <GraphWorkspace />
      : view === 'shelf' ? <ModelShelf />
      : view === 'gallery' ? <Gallery />
      : view === 'controls' ? <ControlsPage />
      : view === 'settings' ? <SettingsPage />
      : view === 'diagnostics' ? <DiagnosticsPage />
      : view === 'performance' ? <PerformancePage />
      : view === 'support' ? <SupportPage />
      : view === 'credits' ? <CreditsPage />
      : <GuideView onOpenControls={() => setView('controls')} />;

  return (
    <div className={`shell ${compactMode ? 'compact' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <BrandMark size={26} />
          <span className="lumen">Lumen</span><span className="deck">Deck</span>
          <span className="ver">v{APP_VERSION}</span>
        </div>
        <span className="view-title">{VIEW_TITLES[view] ?? 'Guide'}</span>
        <div className="topbar-right">
          <BridgeStatus />
          <HealthChip />
          <button className="btn controls-toggle" type="button" aria-label="Open Controls" onClick={() => setView('controls')}>
            {Icon.gear({ size: 18 })} Controls
          </button>
          <button className="btn icon controls-toggle" type="button" aria-label="Open Settings" onClick={() => setView('settings')}>
            {Icon.gear({ size: 18 })}
          </button>
        </div>
      </header>
      <div className="workspace">
        <NavRail view={view} setView={setView} />
        <div className="main-pane">
          {page}
        </div>
      </div>
    </div>
  );
}
