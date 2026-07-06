import { useMemo, useState } from 'react';
import { formatDiagnosticsReport } from '../core/diagnostics';
import { fallbackReasonFor, isFallbackRender, renderBackendLabel } from '../core/renderHonesty';
import { estimateGalleryStorage } from '../core/storageStatus';
import { useStudio } from '../state/store';
import { APP_VERSION } from '../state/storeConstants';
import { Icon } from '../components/icons';

function Metric({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === undefined || value === null || value === '' ? 'unknown' : String(value)}</dd>
    </div>
  );
}

export function DiagnosticsPage() {
  const state = useStudio();
  const [copyStatus, setCopyStatus] = useState('');
  const storage = estimateGalleryStorage(state.gallery);
  const latestFallback = state.gallery.find((item) => isFallbackRender(item));
  const latestJob = state.queue[0];
  const report = useMemo(() => formatDiagnosticsReport({
    appVersion: APP_VERSION,
    selectedBackend: state.backendSettings.selectedBackend,
    bridgeOnline: state.bridgeOnline,
    backendSettings: state.backendSettings,
    bridgeModelStatus: state.bridgeModelStatus,
    bridgeModelError: state.bridgeModelError,
    bridgeModelFolderStatus: state.bridgeModelFolderStatus,
    bridgeModelFolderError: state.bridgeModelFolderError,
    shelfSource: state.shelfSource,
    assetCount: state.shelf.length,
    health: state.health,
    queue: state.queue,
    gallery: state.gallery,
  }), [state]);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus('Diagnostics copied.');
    } catch {
      setCopyStatus('Clipboard unavailable. Select the report text and copy it manually.');
    }
  };

  return (
    <main className="studio-page diagnostics-page scroll" aria-label="Diagnostics">
      <div className="studio-page-inner">
        <header className="page-hero">
          <div>
            <p className="page-kicker">Diagnostics</p>
            <h1>Renderer Cockpit</h1>
            <p>Check backend, CUDA, model cache, folder scan, queue, and fallback state without guessing.</p>
          </div>
          <div className="page-hero-actions">
            <button className="btn primary" type="button" onClick={() => void state.testSelectedBackend()}>{Icon.pulse()} Test backend</button>
            <button className="btn" type="button" onClick={() => state.setView('settings')}>{Icon.gear()} Settings</button>
            <button className="btn" type="button" onClick={() => state.setView('controls')}>{Icon.play()} Controls</button>
          </div>
        </header>

        {copyStatus ? <div className="status-banner" role="status">{copyStatus}</div> : null}

        <section className="page-grid">
          <article className="card page-card">
            <div className="page-card-head">
              <h2>Backend Status</h2>
              <span className={`chip ${state.bridgeOnline ? 'clean' : 'warnings'}`}>{state.backendSettings.selectedBackend}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="App version" value={APP_VERSION} />
              <Metric label="Bridge online" value={state.bridgeOnline} />
              <Metric label="Bridge URL" value={state.backendSettings.bridgeUrl} />
              <Metric label="ComfyUI URL" value={state.backendSettings.comfyUrl} />
              <Metric label="Bridge renderer" value={state.backendSettings.bridgeRenderer} />
              <Metric label="Fallback enabled" value={state.backendSettings.fallbackToMock} />
              <Metric label="Last health" value={state.backendSettings.lastHealth?.status ?? 'not tested'} />
              <Metric label="Health message" value={state.backendSettings.lastHealth?.message ?? 'none'} />
            </dl>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Diffusers / CUDA</h2>
              <span className={`chip ${state.bridgeModelStatus?.cuda ? 'clean' : 'warnings'}`}>{state.bridgeModelStatus?.device ?? 'unknown'}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Model ID" value={state.bridgeModelStatus?.modelId} />
              <Metric label="Dependencies ready" value={state.bridgeModelStatus?.dependenciesReady} />
              <Metric label="Loaded" value={state.bridgeModelStatus?.loaded} />
              <Metric label="Model cached" value={state.bridgeModelStatus?.modelCached} />
              <Metric label="CUDA" value={state.bridgeModelStatus?.cuda} />
              <Metric label="Cache directory" value={state.bridgeModelStatus?.cacheDir} />
              <Metric label="Installable" value={state.bridgeModelStatus?.installable} />
              <Metric label="Runtime path" value={state.bridgeModelStatus?.managedRuntime?.path} />
              <Metric label="Managed Python" value={state.bridgeModelStatus?.managedRuntime?.python} />
            </dl>
            {state.bridgeModelStatus?.message ? <p className="field-help">{state.bridgeModelStatus.message}</p> : null}
            {state.bridgeModelError ? <p className="backend-model-error">{state.bridgeModelError}</p> : null}
            <div className="control-button-grid">
              <button className="btn" type="button" onClick={() => void state.refreshBridgeModelStatus()} disabled={state.bridgeModelBusy}>{Icon.pulse()} Check model</button>
              <button className="btn primary" type="button" onClick={() => void state.installBridgeRuntime()} disabled={state.bridgeModelBusy}>{Icon.download()} Install runtime + model</button>
              <button className="btn" type="button" onClick={() => void state.downloadBridgeModel()} disabled={state.bridgeModelBusy || !state.bridgeModelStatus?.dependenciesReady}>{Icon.download()} Download model</button>
            </div>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Model Folder</h2>
              <span className="chip">{state.shelfSource}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Configured" value={state.bridgeModelFolderStatus?.configured} />
              <Metric label="Active" value={state.bridgeModelFolderStatus?.active} />
              <Metric label="Asset count" value={state.bridgeModelFolderStatus?.assetCount ?? state.shelf.length} />
              <Metric label="Checkpoints" value={state.bridgeModelFolderStatus?.checkpointCount} />
              <Metric label="LoRAs" value={state.bridgeModelFolderStatus?.loraCount} />
              <Metric label="Using demo" value={state.bridgeModelFolderStatus?.usingDemo} />
              <Metric label="Folder error" value={state.bridgeModelFolderError ?? 'none'} />
            </dl>
            <div className="control-button-grid">
              <button className="btn" type="button" onClick={() => void state.refreshModelFolderStatus()} disabled={state.bridgeModelFolderBusy}>{Icon.folder()} Refresh folder</button>
              <button className="btn" type="button" onClick={() => void state.refreshShelfFromBridge()}>{Icon.grid()} Refresh shelf</button>
            </div>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Queue / Fallback</h2>
              <span className={`chip ${latestFallback ? 'warnings' : 'clean'}`}>{latestFallback ? 'fallback seen' : 'clean'}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Queue size" value={state.queue.length} />
              <Metric label="Latest job" value={latestJob ? `${latestJob.status} ${latestJob.phase ?? ''}` : 'none'} />
              <Metric label="Latest error" value={latestJob?.error ?? 'none'} />
              <Metric label="Last fallback backend" value={latestFallback ? renderBackendLabel(latestFallback) : 'none'} />
              <Metric label="Last fallback reason" value={latestFallback ? fallbackReasonFor(latestFallback) : 'none'} />
              <Metric label="Graph health" value={`${state.health.filter((i) => i.severity === 'error').length} errors`} />
            </dl>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Storage</h2>
              <span className="chip">{storage.persistenceMode}</span>
            </div>
            <dl className="page-metrics">
              <Metric label="Gallery items" value={storage.itemCount} />
              <Metric label="Approximate size" value={storage.approximateLabel} />
              <Metric label="Planned desktop path" value={storage.plannedDesktopPath} />
              <Metric label="Subfolders" value={storage.plannedSubfolders.join(', ')} />
            </dl>
            {storage.warning ? <p className="field-help">{storage.warning}</p> : null}
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>ComfyUI Endpoints</h2>
              <span className="chip">API</span>
            </div>
            <p className="field-help">ComfyUI must be running with API access. CORS or firewall errors usually mean the browser cannot reach the ComfyUI server.</p>
            <ul className="guide-issue-list">
              <li><code>/system_stats</code> connection health</li>
              <li><code>/prompt</code> workflow submit</li>
              <li><code>/history/&lt;prompt_id&gt;</code> completion polling</li>
              <li><code>/view</code> output fetch</li>
            </ul>
            <div className="control-button-grid">
              <button className="btn" type="button" disabled>Import Comfy workflow JSON</button>
              <button className="btn" type="button" disabled>Export current graph as Comfy workflow</button>
            </div>
          </article>

          <article className="card page-card wide">
            <div className="page-card-head">
              <h2>Copyable Report</h2>
              <button className="btn primary" type="button" onClick={() => void copyReport()}>{Icon.save()} Copy diagnostics</button>
            </div>
            <textarea className="diagnostics-report" readOnly value={report} onFocus={(event) => event.currentTarget.select()} />
          </article>
        </section>
      </div>
    </main>
  );
}
