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
    bridgeModelFolderStatus,
    bridgeOnline,
    enqueueRender,
    gallery,
    health,
    installBridgeRuntime,
    queue,
    rackSlots,
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
  const enabledLoras = rackSlots().filter((slot) => slot.enabled);
  const installedCheckpoints = shelf.filter((asset) => asset.assetType === 'checkpoint' && asset.installed);
  const localCheckpoints = bridgeModelFolderStatus?.checkpointCount ?? 0;

  const usingBridge = backendSettings.selectedBackend === 'bridge' || adapterId === 'bridge';
  const realRenderer = backendSettings.bridgeRenderer === 'diffusers' || backendSettings.bridgeRenderer === 'auto';
  const dependenciesReady = bridgeModelStatus?.dependenciesReady === true;
  const modelDownloaded = bridgeModelStatus?.loaded === true || bridgeModelStatus?.modelCached === true;
  const realModelReady = usingBridge && bridgeOnline && realRenderer && dependenciesReady && modelDownloaded;
  const canInstallRuntime = !bridgeModelBusy;
  const graphReady = errors.length === 0;
  const recipeReady = Boolean(prompt && checkpoint && checkpoint.installed && width > 0 && height > 0);
  const canRenderReal = realModelReady && graphReady && recipeReady && !bridgeModelBusy;

  const cuda = bridgeModelStatus?.cuda === true;
  const device = bridgeModelStatus?.device ?? 'unknown';
  const modelsReady = installedCheckpoints.length > 0;

  const backendState: StepState = bridgeOnline && usingBridge ? 'done' : bridgeOnline ? 'warning' : 'blocked';
  const gpuState: StepState = cuda ? 'done' : device === 'cpu' ? 'warning' : 'blocked';
  const runtimeState: StepState = realModelReady ? 'done' : dependenciesReady || modelDownloaded ? 'warning' : 'blocked';
  const modelsState: StepState = modelsReady ? 'done' : 'warning';
  const graphState: StepState = graphReady ? 'done' : 'blocked';
  const recipeState: StepState = recipeReady ? 'done' : 'warning';
  const renderState: StepState = latestJob?.status === 'done' || gallery.length > 0 ? 'done' : canRenderReal ? 'warning' : 'blocked';

  const chooseRealBackend = () => {
    setAdapter('bridge');
    updateBackendSettings({ selectedBackend: 'bridge', bridgeRenderer: 'auto', fallbackToMock: false });
  };

  return (
    <main className="guide scroll" aria-label="Generate tutorial">
      <div className="guide-inner">
        <header className="guide-head">
          <div>
            <p className="guide-kicker">Real photos, step by step</p>
            <h1>Generate your first real photo</h1>
            <p>
              Work down this checklist — each item reflects live LumenDeck state, so the blocked one is
              usually what's stopping generation. Real images come from the Diffusers bridge on your GPU;
              anything else is the procedural placeholder.
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
          <StatusTile label="Device" value={cuda ? 'GPU (CUDA)' : device === 'cpu' ? 'CPU only' : 'unknown'} state={gpuState} />
          <StatusTile label="Renderer" value={backendSettings.bridgeRenderer} state={realRenderer ? 'done' : 'warning'} />
          <StatusTile label="Model" value={modelDownloaded ? 'Ready' : dependenciesReady ? 'Runtime ready' : 'Needs install'} state={runtimeState} />
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
              Real photos come from the bridge backend, not Mock. Launch LumenDeck with the desktop app,
              <code> run.bat</code>, or <code>npm run dev</code> — the bridge starts automatically — then keep the
              backend on <strong>Diffusers bridge</strong> with renderer <strong>auto</strong> or <strong>diffusers</strong>.
            </p>
            {!bridgeOnline ? <p className="guide-note danger">The bridge isn't answering right now. Restart the app or dev server, then Check bridge.</p> : null}
          </Step>

          <Step
            number={2}
            state={gpuState}
            title="Render on your GPU (not CPU)"
            actions={
              <>
                <button className="btn primary" type="button" onClick={() => void installBridgeRuntime()} disabled={!canInstallRuntime}>
                  {Icon.download()} {bridgeModelBusy ? 'Installing…' : 'Install GPU runtime'}
                </button>
                <button className="btn" type="button" onClick={() => void refreshBridgeModelStatus()}>{Icon.pulse()} Check device</button>
              </>
            }
          >
            <p>
              SDXL/Pony checkpoints need a GPU — on CPU they run out of memory and fall back to a placeholder.
              <strong> Install GPU runtime</strong> sets up an app-local Python with CUDA PyTorch and downloads SD-Turbo.
              On an NVIDIA card the device below should read <strong>GPU (CUDA)</strong>.
            </p>
            <dl className="guide-mini-grid">
              <div><dt>Device</dt><dd>{cuda ? 'GPU (CUDA)' : device}</dd></div>
              <div><dt>Runtime</dt><dd>{dependenciesReady ? 'ready' : 'not installed'}</dd></div>
              <div><dt>SD-Turbo</dt><dd>{modelDownloaded ? 'downloaded' : 'not downloaded'}</dd></div>
            </dl>
            {device === 'cpu' ? <p className="guide-note">Running on CPU: SD-Turbo and SD1.5 work but are slow; large SDXL models likely won't fit. A CUDA GPU is strongly recommended.</p> : null}
            {bridgeModelStatus?.message ? <p className="guide-note">{bridgeModelStatus.message}</p> : null}
            {bridgeModelError ? <p className="guide-note danger">{bridgeModelError}</p> : null}
          </Step>

          <Step
            number={3}
            state={modelsState}
            title="Get a model (Civitai or your own)"
            actions={
              <>
                <button className="btn primary" type="button" onClick={() => setView('shelf')}>{Icon.download()} Browse Civitai</button>
                <button className="btn" type="button" onClick={() => setView('shelf')}>{Icon.folder()} Model shelf</button>
              </>
            }
          >
            <p>
              Three ways to get real models, all on the <strong>Model Shelf</strong>:
            </p>
            <ul className="guide-issue-list">
              <li><strong>SD-Turbo</strong> — downloaded for you by the GPU runtime step above; great for fast tests.</li>
              <li><strong>Civitai</strong> — search and download checkpoints or LoRAs straight into your model folder.</li>
              <li><strong>Bring your own</strong> — point LumenDeck at an existing models folder (ComfyUI/A1111) to scan it.</li>
            </ul>
            <dl className="guide-mini-grid">
              <div><dt>Installed checkpoints</dt><dd>{installedCheckpoints.length}</dd></div>
              <div><dt>Local folder</dt><dd>{bridgeModelFolderStatus?.active ? `${localCheckpoints} checkpoints` : 'auto / demo'}</dd></div>
            </dl>
          </Step>

          <Step
            number={4}
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
            number={5}
            state={recipeState}
            title="Set the prompt, checkpoint & LoRAs"
            actions={
              <>
                <button className="btn" type="button" onClick={() => setView('recipe')}>{Icon.home()} Edit recipe</button>
                <button className="btn" type="button" onClick={() => setView('shelf')}>{Icon.grid()} Model shelf</button>
              </>
            }
          >
            <p>
              In the Recipe view set your prompt, pick a checkpoint, and (optionally) stack LoRAs in the rack —
              their weights apply to real renders. Keep the canvas moderate for fast first tests.
            </p>
            <dl className="guide-mini-grid">
              <div><dt>Prompt</dt><dd>{prompt || 'empty'}</dd></div>
              <div><dt>Checkpoint</dt><dd>{checkpoint?.name ?? 'not selected'}</dd></div>
              <div><dt>LoRAs</dt><dd>{enabledLoras.length ? `${enabledLoras.length} active` : 'none'}</dd></div>
              <div><dt>Canvas</dt><dd>{width && height ? `${width} × ${height}` : 'unknown'}</dd></div>
            </dl>
          </Step>

          <Step
            number={6}
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
            <p>After you press Render, watch the Queue in Controls. The first real render sits on “loading” while the model warms up, then steps advance live.</p>
            {latestJob ? (
              <p className={`guide-note ${latestJob.status === 'error' ? 'danger' : ''}`}>
                Last job: {latestJob.status} at {Math.round(latestJob.progress * 100)}%{latestJob.error ? ` — ${latestJob.error}` : ''}
              </p>
            ) : null}
          </Step>
        </section>

        <section className="guide-troubleshooting">
          <h2>Troubleshooting</h2>
          <div className="guide-help-grid">
            <p><strong>It renders but looks fake.</strong> Backend must be Diffusers bridge, renderer auto/diffusers, and the device should read GPU (CUDA). A red “Real render failed…” note in the Queue shows the exact reason.</p>
            <p><strong>SDXL/Pony crashes or is missing.</strong> Those need a GPU; on CPU they run out of memory. Install the GPU runtime, or use SD-Turbo / an SD1.5 model.</p>
            <p><strong>Civitai download needs a token.</strong> Some models require one — add a Civitai API key in the browser's token field on the Model Shelf.</p>
            <p><strong>Connection fails.</strong> Restart from the repo with <code>run.bat</code> or <code>npm run dev</code>; the bridge answers on <code>/health</code> through the app.</p>
          </div>
          {latestError?.error ? <p className="guide-note danger">Most recent queue error: {latestError.error}</p> : null}
        </section>
      </div>
    </main>
  );
}
