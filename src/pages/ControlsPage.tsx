import { useMemo, useState } from 'react';
import { findNode } from '../core/workflow';
import { useStudio } from '../state/store';
import { Icon } from '../components/icons';
import { HealthPanel } from '../components/health/HealthPanel';
import { Inspector } from '../components/inspector/Inspector';
import { QueuePanel } from '../components/queue/QueuePanel';
import { ControlNetRack } from '../components/rack/ControlNetRack';
import { LoraRack } from '../components/rack/LoraRack';
import { PromptStudio } from '../components/prompt/PromptStudio';
import { TURBO_PRESETS } from '../turboForge/presets';
import type { RenderBackendId } from '../turboForge/backends/backendSettings';
import type { TurboPresetId } from '../turboForge/types';
import { createRenderPlan } from '../turboForge/renderPlanner';

function FieldValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function ControlsPage() {
  const {
    appSettings,
    backendSettings,
    bridgeModelFolderStatus,
    bridgeOnline,
    clearQueue,
    clearTurboCache,
    controlStatus,
    createTurboPlan,
    enqueueBatch,
    enqueueRender,
    gallery,
    health,
    queue,
    queuePaused,
    refreshModelFolderStatus,
    refreshShelfFromBridge,
    runTurboBenchmark,
    cancelRunningJobs,
    pauseQueue,
    resumeQueue,
    setView,
    setAdapter,
    setControlStatus,
    setTurboPreset,
    shelf,
    turboBusy,
    turboBackendId,
    turboBenchmarks,
    turboLastPlan,
    turboPresetId,
    updateAppSettings,
    updateBackendSettings,
    workflow,
  } = useStudio();
  const [batchCount, setBatchCount] = useState(2);

  const errors = health.filter((issue) => issue.severity === 'error');
  const warnings = health.filter((issue) => issue.severity !== 'error');
  const modelNode = findNode(workflow, 'model');
  const selectedModel = shelf.find((asset) => asset.id === String(modelNode?.params.assetId ?? ''));
  const running = queue.filter((job) => job.status === 'running');
  const latest = queue[0];
  const plan = useMemo(
    () => turboLastPlan ?? createRenderPlan(workflow, shelf, { presetId: turboPresetId, backendId: turboBackendId, history: turboBenchmarks }),
    [shelf, turboBackendId, turboBenchmarks, turboLastPlan, turboPresetId, workflow],
  );
  const outputDir = appSettings.outputDirectory || 'Not set';

  const runPreflight = () => {
    const next = createTurboPlan();
    setControlStatus(
      next.warnings.length
        ? `Preflight finished with ${next.warnings.length} warning${next.warnings.length === 1 ? '' : 's'}.`
        : 'Preflight passed. Render plan is ready.',
    );
  };

  const refreshModels = async () => {
    await Promise.all([refreshShelfFromBridge(), refreshModelFolderStatus()]);
    setControlStatus('Model shelf refresh requested.');
  };

  const changeBackend = (backend: RenderBackendId) => {
    setAdapter(backend);
    updateBackendSettings({ selectedBackend: backend });
  };

  const changePreset = (preset: TurboPresetId) => {
    setTurboPreset(preset);
    updateAppSettings({ turboAccelerationProfile: preset });
  };

  return (
    <main className="studio-page controls-page scroll" aria-label="Controls">
      <div className="studio-page-inner">
        <header className="page-hero">
          <div>
            <p className="page-kicker">Controls</p>
            <h1>Render Command Center</h1>
            <p>Start renders, check the plan, tune TurboForge, and manage the queue from one place.</p>
          </div>
          <div className="page-hero-actions">
            <button className="btn primary" type="button" disabled={errors.length > 0 || queuePaused} onClick={() => void enqueueRender()}>
              {Icon.play()} Start Render
            </button>
            <button className="btn" type="button" disabled={errors.length > 0 || queuePaused} onClick={() => void enqueueBatch(batchCount)}>
              {Icon.grid()} Batch
            </button>
            <button className="btn" type="button" onClick={runPreflight}>
              {Icon.pulse()} Preflight
            </button>
          </div>
        </header>

        {controlStatus ? <div className="status-banner" role="status">{controlStatus}</div> : null}
        {errors.length > 0 || !bridgeOnline || backendSettings.selectedBackend === 'mock' ? (
          <div className="status-banner warning" role="status">
            <strong>{errors.length ? 'Render is blocked.' : backendSettings.selectedBackend === 'mock' ? 'Mock backend is selected.' : 'Backend is offline.'}</strong>
            <span> Use Diagnostics for the exact failure or Settings to pick a real backend.</span>
            <button className="btn" type="button" onClick={() => setView('diagnostics')}>{Icon.pulse()} Diagnostics</button>
            <button className="btn" type="button" onClick={() => setView('settings')}>{Icon.gear()} Settings</button>
          </div>
        ) : null}

        <section className="page-grid">
          <article className="card page-card">
            <div className="page-card-head">
              <h2>Render Controls</h2>
              <span className={`chip ${errors.length ? 'errors' : 'clean'}`}>{errors.length ? `${errors.length} blocked` : 'ready'}</span>
            </div>
            <div className="control-button-grid">
              <button className="btn primary" type="button" disabled={errors.length > 0 || queuePaused} onClick={() => void enqueueRender()}>
                {Icon.play()} Start Render
              </button>
              <button className="btn" type="button" disabled={errors.length > 0 || queuePaused} onClick={() => void enqueueBatch(batchCount)}>
                {Icon.grid()} Render batch
              </button>
              <button className="btn" type="button" onClick={queuePaused ? resumeQueue : pauseQueue}>
                {queuePaused ? 'Resume' : 'Pause'}
              </button>
              <button className="btn" type="button" onClick={cancelRunningJobs} disabled={running.length === 0}>
                Stop / Cancel
              </button>
              <button className="btn" type="button" onClick={runPreflight}>
                Dry Run
              </button>
            </div>
            <label className="field">
              <span className="field-label">Batch / seed grid count</span>
              <input type="number" min={1} max={16} value={batchCount} onChange={(event) => setBatchCount(Number(event.target.value))} />
              <span className="field-help">Runs 1-16 renders back to back. Use seed -1 for variations.</span>
            </label>
            <p className="field-help">Pause and cancel are local queue controls. Backend-level interruption is not connected yet.</p>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>TurboForge Controls</h2>
              <span className="chip">{plan.selectedPreset}</span>
            </div>
            <label className="field">
              <span className="field-label">Preset</span>
              <select value={turboPresetId} onChange={(event) => changePreset(event.target.value as TurboPresetId)}>
                {Object.values(TURBO_PRESETS).map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.beginnerLabel}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Backend</span>
              <select value={backendSettings.selectedBackend} onChange={(event) => changeBackend(event.target.value as RenderBackendId)}>
                <option value="mock">Built-in mock</option>
                <option value="bridge">Local Diffusers bridge</option>
                <option value="comfyui">ComfyUI API</option>
              </select>
            </label>
            <label className="field-inline">
              <span><span className="field-label">Compile cache</span><span className="field-help">Planning flag; native compile cache is backend-dependent.</span></span>
              <button className="switch" type="button" role="switch" aria-checked={appSettings.compileCacheEnabled}
                onClick={() => updateAppSettings({ compileCacheEnabled: !appSettings.compileCacheEnabled })} />
            </label>
            <label className="field-inline">
              <span><span className="field-label">LoRA optimizer</span><span className="field-help">Controls local planning hints for LoRA-heavy recipes.</span></span>
              <button className="switch" type="button" role="switch" aria-checked={appSettings.loraOptimizerEnabled}
                onClick={() => updateAppSettings({ loraOptimizerEnabled: !appSettings.loraOptimizerEnabled })} />
            </label>
            <div className="control-button-grid">
              <button className="btn primary" type="button" onClick={() => void runTurboBenchmark()} disabled={turboBusy}>
                {Icon.bolt()} {turboBusy ? 'Benchmarking...' : 'Capture benchmark'}
              </button>
              <button className="btn" type="button" onClick={clearTurboCache}>Clear cache</button>
            </div>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Model Controls</h2>
              <span className="chip">{selectedModel?.family ?? 'none'}</span>
            </div>
            <dl className="page-metrics">
              <FieldValue label="Active model" value={selectedModel?.name ?? 'No checkpoint selected'} />
              <FieldValue label="Family/type" value={selectedModel ? `${selectedModel.family} checkpoint` : 'Unknown'} />
              <FieldValue label="Path" value={selectedModel?.path ?? 'Choose a model on the Model Shelf'} />
              <FieldValue label="Model folder" value={bridgeModelFolderStatus?.active || appSettings.modelDirectory || 'Auto / not set'} />
            </dl>
            <div className="control-button-grid">
              <button className="btn primary" type="button" onClick={() => void refreshModels()}>{Icon.pulse()} Refresh models</button>
              <button className="btn" type="button" onClick={() => setControlStatus('Model path picker is not connected yet. Use Model Shelf for now.')}>
                Model path selector
              </button>
            </div>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Output Controls</h2>
              <span className="chip">{appSettings.saveManifest ? 'manifest on' : 'manifest off'}</span>
            </div>
            <dl className="page-metrics">
              <FieldValue label="Output directory" value={outputDir} />
              <FieldValue label="Gallery items" value={`${gallery.length}`} />
            </dl>
            <label className="field-inline">
              <span><span className="field-label">Save manifest</span><span className="field-help">Gallery manifests remain available; disk embedding depends on backend support.</span></span>
              <button className="switch" type="button" role="switch" aria-checked={appSettings.saveManifest}
                onClick={() => updateAppSettings({ saveManifest: !appSettings.saveManifest })} />
            </label>
            <button className="btn" type="button" onClick={() => setControlStatus('Open output folder is not connected to native shell APIs yet.')}>
              {Icon.folder()} Open output folder
            </button>
          </article>

          <article className="card page-card wide">
            <div className="page-card-head">
              <h2>Queue Controls</h2>
              <span className={`chip ${queuePaused ? 'warnings' : 'clean'}`}>{queuePaused ? 'paused' : `${running.length} running`}</span>
            </div>
            <dl className="page-metrics queue-summary">
              <FieldValue label="Current job" value={latest ? `${latest.status}: ${latest.label}` : 'No jobs'} />
              <FieldValue label="Progress" value={latest ? `${Math.round(latest.progress * 100)}% ${latest.phase ?? ''}` : 'Idle'} />
              <FieldValue label="Graph health" value={`${errors.length} errors, ${warnings.length} warnings`} />
              <FieldValue label="Estimated plan" value={`${plan.steps} steps, ${plan.resolution.width}x${plan.resolution.height}, ${plan.estimatedVramGB.toFixed(1)} GB VRAM`} />
              <FieldValue label="Warnings" value={`${plan.warnings.length}`} />
            </dl>
            <div className="control-button-grid">
              <button className="btn" type="button" onClick={queuePaused ? resumeQueue : pauseQueue}>{queuePaused ? 'Resume queue' : 'Pause queue'}</button>
              <button className="btn" type="button" onClick={cancelRunningJobs} disabled={running.length === 0}>Cancel running</button>
              <button className="btn" type="button" onClick={clearQueue} disabled={queue.length === 0}>Clear queue</button>
            </div>
          </article>

          <article className="card page-card wide">
            <div className="page-card-head">
              <h2>Live Queue</h2>
              <span className="chip">{queue.length} jobs</span>
            </div>
            {queue.length ? <QueuePanel /> : <p className="field-help">No queued renders yet.</p>}
          </article>

          <article className="card page-card">
            <HealthPanel />
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Inspector</h2>
              <span className="chip">selected capsule</span>
            </div>
            <Inspector />
          </article>

          <article className="card page-card wide">
            <PromptStudio />
          </article>

          <article className="card page-card wide">
            <LoraRack />
          </article>

          <article className="card page-card wide">
            <ControlNetRack />
          </article>
        </section>
      </div>
    </main>
  );
}
