import type React from 'react';
import { findNode } from '../../core/workflow';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';

type StepState = 'done' | 'warning' | 'blocked';

function stateIcon(state: StepState) {
  if (state === 'done') return Icon.ok({ size: 18 });
  if (state === 'warning') return Icon.warning({ size: 18 });
  return Icon.error({ size: 18 });
}

function Step({
  number,
  state,
  title,
  children,
  actions,
}: {
  number: number;
  state: StepState;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <article className={`guide-step ${state}`}>
      <span className="guide-step-marker" aria-hidden="true">
        {stateIcon(state)}
        <span>{number}</span>
      </span>
      <div className="guide-step-body">
        <h3>{title}</h3>
        <div className="guide-step-copy">{children}</div>
        {actions ? <div className="guide-step-actions">{actions}</div> : null}
      </div>
    </article>
  );
}

function StatusTile({ label, value, state }: { label: string; value: string; state: StepState }) {
  return (
    <div className={`guide-status-tile ${state}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function GuideView({ onOpenControls }: { onOpenControls: () => void }) {
  const {
    adapterId,
    backendSettings,
    bridgeModelBusy,
    bridgeModelError,
    bridgeModelStatus,
    bridgeOnline,
    downloadBridgeModel,
    enqueueRender,
    gallery,
    health,
    installBridgeRuntime,
    queue,
    refreshBridgeModelStatus,
    setAdapter,
    setView,
    shelf,
    updateBackendSettings,
    workflow,
  } = useStudio();

  const errors = health.filter((issue) => issue.severity === 'error');
  const latestJob = queue[0];
  const latestError = queue.find((job) => job.status === 'error' && job.error);
  const modelNode = findNode(workflow, 'model');
  const promptNode = findNode(workflow, 'prompt');
  const canvasNode = findNode(workflow, 'canvas');
  const checkpointId = String(modelNode?.params.assetId ?? '');
  const checkpoint = shelf.find((asset) => asset.id === checkpointId);
  const prompt = String(promptNode?.params.positive ?? '').trim();
  const width = Number(canvasNode?.params.width ?? 0);
  const height = Number(canvasNode?.params.height ?? 0);

  const usingBridge = backendSettings.selectedBackend === 'bridge' || adapterId === 'bridge';
  const realRenderer = backendSettings.bridgeRenderer === 'diffusers' || backendSettings.bridgeRenderer === 'auto';
  const dependenciesReady = bridgeModelStatus?.dependenciesReady === true;
  const modelDownloaded = bridgeModelStatus?.loaded === true || bridgeModelStatus?.modelCached === true;
  const realModelReady = usingBridge && bridgeOnline && realRenderer && dependenciesReady && modelDownloaded;
  const canInstallRuntime = !bridgeModelBusy && bridgeModelStatus?.installable !== false;
  const graphReady = errors.length === 0;
  const recipeReady = Boolean(prompt && checkpoint && checkpoint.installed && width > 0 && height > 0);
  const canRenderReal = realModelReady && graphReady && recipeReady && !bridgeModelBusy;

  const backendState: StepState = bridgeOnline && usingBridge ? 'done' : bridgeOnline ? 'warning' : 'blocked';
  const modelState: StepState = realModelReady ? 'done' : dependenciesReady || modelDownloaded ? 'warning' : 'blocked';
  const graphState: StepState = graphReady ? 'done' : 'blocked';
  const recipeState: StepState = recipeReady ? 'done' : 'warning';
  const renderState: StepState = latestJob?.status === 'done' || gallery.length > 0 ? 'done' : canRenderReal ? 'warning' : 'blocked';

  const chooseRealBackend = () => {
    setAdapter('bridge');
    updateBackendSettings({ selectedBackend: 'bridge', bridgeRenderer: 'diffusers', fallbackToMock: false });
  };

  return (
    <main className="guide scroll" aria-label="Generate tutorial">
      <div className="guide-inner">
        <header className="guide-head">
          <div>
            <p className="guide-kicker">First real render</p>
            <h1>Generate your first photo</h1>
            <p>
              Work down this checklist. Each step reflects the current LumenDeck state, so the blocked item is usually the thing stopping generation.
            </p>
          </div>
          <div className="guide-head-actions">
            <button className="btn primary" type="button" onClick={() => void enqueueRender()} disabled={!canRenderReal}>
              {Icon.play()} Render real photo
            </button>
            <button className="btn" type="button" onClick={onOpenControls}>
              {Icon.gear()} Controls
            </button>
          </div>
        </header>

        <section className="guide-status-grid" aria-label="Current render status">
          <StatusTile label="Backend" value={usingBridge ? (bridgeOnline ? 'Bridge online' : 'Bridge offline') : 'Mock selected'} state={backendState} />
          <StatusTile label="Renderer" value={backendSettings.bridgeRenderer} state={realRenderer ? 'done' : 'warning'} />
          <StatusTile label="Model" value={modelDownloaded ? 'Downloaded' : dependenciesReady ? 'Runtime ready' : 'Needs install'} state={modelState} />
          <StatusTile label="Graph" value={graphReady ? 'Healthy' : `${errors.length} error${errors.length === 1 ? '' : 's'}`} state={graphState} />
        </section>

        <section className="guide-steps" aria-label="Generation checklist">
          <Step
            number={1}
            state={backendState}
            title="Use the local Diffusers bridge"
            actions={
              <>
                <button className="btn primary" type="button" onClick={chooseRealBackend}>
                  {Icon.plug()} Use real bridge
                </button>
                <button className="btn" type="button" onClick={() => void refreshBridgeModelStatus()}>
                  {Icon.pulse()} Check bridge
                </button>
              </>
            }
          >
            <p>
              Real photos come from the bridge backend, not Mock. Start LumenDeck with the desktop app, `run.bat`, or `npm run dev`, then keep the backend set to Diffusers bridge.
            </p>
            {!bridgeOnline ? <p className="guide-note danger">The bridge is not answering right now. Restart the app or dev server, then check again.</p> : null}
          </Step>

          <Step
            number={2}
            state={modelState}
            title="Install the real photo runtime and model"
            actions={
              <>
                <button className="btn primary" type="button" onClick={() => void installBridgeRuntime()} disabled={!canInstallRuntime}>
                  {Icon.download()} {bridgeModelBusy ? 'Installing...' : 'Install runtime + model'}
                </button>
                <button className="btn" type="button" onClick={() => void downloadBridgeModel()} disabled={bridgeModelBusy || !dependenciesReady}>
                  {Icon.download()} Download model
                </button>
              </>
            }
          >
            <p>
              The first install can take a while because Python packages and SD-Turbo weights are downloaded. Leave the app open until the status changes to downloaded.
            </p>
            <dl className="guide-mini-grid">
              <div><dt>Device</dt><dd>{bridgeModelStatus?.device ?? 'unknown'}</dd></div>
              <div><dt>Model</dt><dd>{bridgeModelStatus?.modelId ?? 'stabilityai/sd-turbo'}</dd></div>
              <div><dt>Cache</dt><dd>{bridgeModelStatus?.cacheDir ?? 'not checked'}</dd></div>
            </dl>
            {bridgeModelStatus?.message ? (
              <p className={`guide-note ${bridgeModelStatus.installable === false ? 'danger' : ''}`}>{bridgeModelStatus.message}</p>
            ) : null}
            {bridgeModelError ? <p className="guide-note danger">{bridgeModelError}</p> : null}
          </Step>

          <Step
            number={3}
            state={graphState}
            title="Clear graph health errors"
            actions={<button className="btn" type="button" onClick={() => setView('graph')}>{Icon.graph()} Open graph</button>}
          >
            {graphReady ? (
              <p>The workflow graph is wired and the selected model is valid.</p>
            ) : (
              <>
                <p>Rendering stays blocked while graph health has errors.</p>
                <ul className="guide-issue-list">
                  {errors.slice(0, 4).map((issue) => <li key={issue.id}>{issue.message}</li>)}
                </ul>
              </>
            )}
          </Step>

          <Step
            number={4}
            state={recipeState}
            title="Check the recipe"
            actions={
              <>
                <button className="btn" type="button" onClick={() => setView('recipe')}>{Icon.home()} Edit recipe</button>
                <button className="btn" type="button" onClick={() => setView('shelf')}>{Icon.grid()} Model shelf</button>
              </>
            }
          >
            <p>Use the Recipe view for the prompt, checkpoint, sampler, and canvas size. For fast first tests, keep the canvas moderate and batch at 1.</p>
            <dl className="guide-mini-grid">
              <div><dt>Prompt</dt><dd>{prompt || 'empty'}</dd></div>
              <div><dt>Checkpoint</dt><dd>{checkpoint?.name ?? 'not selected'}</dd></div>
              <div><dt>Canvas</dt><dd>{width && height ? `${width} x ${height}` : 'unknown'}</dd></div>
            </dl>
          </Step>

          <Step
            number={5}
            state={renderState}
            title="Render and open the gallery"
            actions={
              <>
                <button className="btn primary" type="button" onClick={() => void enqueueRender()} disabled={!canRenderReal}>
                  {Icon.play()} Render real photo
                </button>
                <button className="btn" type="button" onClick={() => setView('gallery')}>{Icon.image()} Gallery</button>
              </>
            }
          >
            <p>After you press Render, watch the Queue in Controls. The first real render may sit on loading while the model warms up.</p>
            {latestJob ? (
              <p className={`guide-note ${latestJob.status === 'error' ? 'danger' : ''}`}>
                Last job: {latestJob.status} at {Math.round(latestJob.progress * 100)}%{latestJob.error ? ` - ${latestJob.error}` : ''}
              </p>
            ) : null}
          </Step>
        </section>

        <section className="guide-troubleshooting">
          <h2>Troubleshooting</h2>
          <div className="guide-help-grid">
            <p><strong>Render is disabled.</strong> Fix the checklist item marked red, usually graph health or the model install.</p>
            <p><strong>It renders but looks fake.</strong> Make sure Backend is Diffusers bridge, Renderer is Diffusers, and fallback to mock is off.</p>
            <p><strong>Connection fails.</strong> Restart from the repo with `run.bat` or `npm run dev`; the bridge should answer on `/health` through the app.</p>
            <p><strong>Model install fails.</strong> Open Controls, use Check model, then retry Install runtime + model. The status message shows the exact missing dependency.</p>
          </div>
          {latestError?.error ? <p className="guide-note danger">Most recent queue error: {latestError.error}</p> : null}
        </section>
      </div>
    </main>
  );
}
