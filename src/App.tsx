import { useEffect, useRef, useState } from 'react';
import { useStudio, type ViewId } from './state/store';
import { StarfieldCanvas } from './ui/starfield/StarfieldCanvas';
import { SplashScreen } from './ui/SplashScreen';
import { useAutoHide } from './ui/chrome/useAutoHide';
import { APP_VERSION } from './state/storeConstants';
import { Gallery } from './components/gallery/Gallery';
import { GuideView } from './components/guide/GuideView';
import { GraphWorkspace } from './components/graph/GraphWorkspace';
import { BrandMark, Icon } from './components/icons';
import { ModelShelf } from './components/shelf/ModelShelf';
import { NavRail } from './components/shell/NavRail';
import { RecipeView } from './components/recipe/RecipeView';
import { MissionControl } from './components/creative/MissionControl';
import { StudioOverview } from './components/creative/StudioOverview';
import { CraftInsights } from './components/creative/CraftInsights';
import { ProjectsView } from './components/creative/ProjectsView';
import { RecipesView } from './components/creative/RecipesView';
import { EntropyView } from './components/creative/EntropyView';
import { ProofView } from './components/creative/ProofView';
import { ControlsPage } from './pages/ControlsPage';
import { CreditsPage } from './pages/CreditsPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { PerformancePage } from './pages/PerformancePage';
import { SettingsPage } from './pages/SettingsPage';
import { SupportPage } from './pages/SupportPage';
import './styles/base.css';
import './styles/app.css';
import './styles/glass.css';

const VIEW_TITLES: Record<ViewId, string> = {
  mission: 'Mission Control',
  overview: 'Studio Overview',
  craft: 'Craft insights',
  projects: 'Projects',
  recipes: 'Creative Recipes',
  entropy: 'Entropy Mode',
  proof: 'Proof Mode',
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
  // Autohide chrome (glass cinema): ON unless explicitly pinned (false).
  const chromeAutohide = useStudio((s) => s.appSettings.chromeAutohide !== false);
  const updateAppSettings = useStudio((s) => s.updateAppSettings);
  // The launch splash plays fully on EVERY launch; the app boots behind it.
  const [splashDone, setSplashDone] = useState(false);
  // Bars stay revealed while the splash plays (no hidden chrome on arrival).
  const autohideArmed = chromeAutohide && splashDone;
  const top = useAutoHide('top', autohideArmed);
  const left = useAutoHide('left', autohideArmed);
  // While the splash covers the app, the shell is `inert`: the overlay blocks
  // the pointer, so keyboard + screen-reader access to the invisible UI must be
  // blocked too (no Tab-activating covered buttons). Set via the DOM property —
  // React 18's JSX types don't know the inert attribute yet.
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (shellRef.current) shellRef.current.inert = !splashDone;
  }, [splashDone]);

  useEffect(() => { void probeBridge(); }, [probeBridge]);

  const page =
    view === 'mission' ? <MissionControl />
      : view === 'overview' ? <StudioOverview />
      : view === 'craft' ? <CraftInsights />
      : view === 'projects' ? <ProjectsView />
      : view === 'recipes' ? <RecipesView />
      : view === 'entropy' ? <EntropyView />
      : view === 'proof' ? <ProofView />
      : view === 'guide' ? <GuideView onOpenControls={() => setView('controls')} />
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
      : <MissionControl />;

  return (
    <>
      <StarfieldCanvas />
      <div ref={shellRef} className={`shell ${compactMode ? 'compact' : ''} ${chromeAutohide ? 'chrome-auto' : ''}`}>
        <header
          className={`topbar ${autohideArmed && !top.visible ? 'chrome-hidden' : ''}`}
          {...top.barProps}
        >
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
            <button
              className="btn icon"
              type="button"
              aria-pressed={!chromeAutohide}
              aria-label={chromeAutohide ? 'Pin the toolbars (stop auto-hiding)' : 'Unpin the toolbars (auto-hide)'}
              title={chromeAutohide ? 'Pin the toolbars (stop auto-hiding)' : 'Unpin the toolbars (auto-hide)'}
              onClick={() => updateAppSettings({ chromeAutohide: !chromeAutohide })}
            >
              {Icon.layers({ size: 18 })}
            </button>
          </div>
        </header>
        <div className="workspace">
          <div
            className={`chrome-left ${autohideArmed && !left.visible ? 'chrome-hidden' : ''}`}
            {...left.barProps}
          >
            <NavRail view={view} setView={setView} />
          </div>
          <div className="main-pane">
            <div className="view-fade" key={view}>
              {page}
            </div>
          </div>
        </div>
      </div>
      {autohideArmed && !top.visible && <div className="chrome-strip top" aria-hidden="true" />}
      {autohideArmed && !left.visible && <div className="chrome-strip left" aria-hidden="true" />}
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
    </>
  );
}
