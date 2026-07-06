import { useState } from 'react';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../state/appSettings';
import { useStudio } from '../state/store';
import { Icon } from '../components/icons';
import { TURBO_PRESETS } from '../turboForge/presets';
import { estimateGalleryStorage } from '../core/storageStatus';
import type { BridgeRenderer, RenderBackendId } from '../turboForge/backends/backendSettings';
import type { TurboPresetId } from '../turboForge/types';

type ApiKeyName = keyof AppSettings['apiKeys'];

function SecretField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="secret-row">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <button className="btn" type="button" onClick={() => setShow((current) => !current)}>
          {show ? 'Mask' : 'Show'}
        </button>
      </div>
    </label>
  );
}

export function SettingsPage() {
  const {
    appSettings,
    backendSettings,
    bridgeModelBusy,
    bridgeModelError,
    bridgeModelStatus,
    bridgeModelFolderStatus,
    downloadBridgeModel,
    gallery,
    installBridgeRuntime,
    refreshBridgeModelStatus,
    refreshModelFolderStatus,
    refreshShelfFromBridge,
    clearLocalHistory,
    controlStatus,
    resetAppSettings,
    setAdapter,
    setControlStatus,
    setTurboPreset,
    setView,
    testSelectedBackend,
    updateAppSettings,
    updateBackendSettings,
  } = useStudio();
  const storage = estimateGalleryStorage(gallery);
  const modelState = bridgeModelStatus
    ? bridgeModelStatus.loaded
      ? 'loaded'
      : bridgeModelStatus.modelCached
        ? 'downloaded'
        : bridgeModelStatus.modelCached === false
          ? 'not downloaded'
          : 'unknown cache'
    : 'unknown';

  const updateApiKey = (name: ApiKeyName, value: string) => {
    updateAppSettings({ apiKeys: { ...appSettings.apiKeys, [name]: value } });
  };

  const setPreferredBackend = (backend: RenderBackendId) => {
    updateAppSettings({ preferredBackend: backend });
    setAdapter(backend);
    updateBackendSettings({ selectedBackend: backend });
  };

  const setAccelerationProfile = (profile: TurboPresetId) => {
    updateAppSettings({ turboAccelerationProfile: profile });
    setTurboPreset(profile);
  };

  const confirmClearLocalHistory = () => {
    if (window.confirm('Clear local gallery, queue, and benchmark history from this browser profile?')) clearLocalHistory();
  };

  const confirmResetSettings = () => {
    if (window.confirm('Reset app settings to safe defaults? Your gallery is not cleared by this action.')) resetAppSettings();
  };

  return (
    <main className="studio-page settings-page scroll" aria-label="Settings">
      <div className="studio-page-inner">
        <header className="page-hero">
          <div>
            <p className="page-kicker">Settings</p>
            <h1>Preferences & Diagnostics</h1>
            <p>Configure local paths, render behavior, privacy defaults, diagnostics, and optional integration keys.</p>
          </div>
          <div className="page-hero-actions">
            <button className="btn" type="button" onClick={() => void testSelectedBackend()}>
              {Icon.pulse()} Test backend
            </button>
            <button className="btn" type="button" onClick={confirmResetSettings}>
              Reset settings
            </button>
          </div>
        </header>

        {controlStatus ? <div className="status-banner" role="status">{controlStatus}</div> : null}

        <section className="page-grid">
          <article className="card page-card">
            <div className="page-card-head">
              <h2>Backend</h2>
              <span className="chip">{backendSettings.selectedBackend}</span>
            </div>
            <label className="field">
              <span className="field-label">Selected backend</span>
              <select value={backendSettings.selectedBackend} onChange={(event) => setPreferredBackend(event.target.value as RenderBackendId)}>
                <option value="mock">Mock / built-in demo renderer</option>
                <option value="bridge">Diffusers bridge: local Python model renderer</option>
                <option value="comfyui">ComfyUI API: your running ComfyUI server</option>
              </select>
              <span className="field-help">Mock is a placeholder/demo path. Bridge and ComfyUI are the real model-backed paths when configured.</span>
            </label>
            <label className="field">
              <span className="field-label">ComfyUI URL</span>
              <input value={backendSettings.comfyUrl} placeholder="http://127.0.0.1:8188"
                onChange={(event) => updateBackendSettings({ comfyUrl: event.target.value })} />
              <span className="field-help">ComfyUI must already be running. LumenDeck uses /system_stats, /prompt, /history/&lt;id&gt;, and /view.</span>
            </label>
            <label className="field">
              <span className="field-label">Diffusers bridge URL</span>
              <input value={backendSettings.bridgeUrl} placeholder="http://127.0.0.1:8787"
                onChange={(event) => updateBackendSettings({ bridgeUrl: event.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Bridge renderer</span>
              <select value={backendSettings.bridgeRenderer} onChange={(event) => updateBackendSettings({ bridgeRenderer: event.target.value as BridgeRenderer })}>
                <option value="auto">Auto: use Diffusers when ready, otherwise bridge fallback</option>
                <option value="procedural">Procedural: local placeholder only</option>
                <option value="diffusers">Diffusers: real model render only</option>
              </select>
            </label>
            <label className="field-inline">
              <span>
                <span className="field-label">Fallback to mock</span>
                <span className="field-help">When enabled, failures can produce placeholder output. Gallery will label those renders as fallback.</span>
              </span>
              <input type="checkbox" checked={backendSettings.fallbackToMock}
                onChange={(event) => updateBackendSettings({ fallbackToMock: event.target.checked })} />
            </label>
            <div className="control-button-grid">
              <button className="btn" type="button" onClick={() => void testSelectedBackend()}>{Icon.pulse()} Test selected backend</button>
              <button className="btn" type="button" onClick={() => updateBackendSettings({ selectedBackend: 'mock', fallbackToMock: true })}>Reset to Mock</button>
              <button className="btn" type="button" onClick={() => updateBackendSettings({ lastHealth: undefined })}>Clear health</button>
            </div>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Runtime / Model</h2>
              <span className={`chip ${bridgeModelStatus?.cuda ? 'clean' : 'warnings'}`}>{bridgeModelStatus?.device ?? 'unknown'}</span>
            </div>
            <dl className="page-metrics">
              <div><dt>Model ID</dt><dd>{bridgeModelStatus?.modelId ?? 'stabilityai/sd-turbo'}</dd></div>
              <div><dt>Dependencies</dt><dd>{bridgeModelStatus?.dependenciesReady ? 'ready' : 'missing'}</dd></div>
              <div><dt>Model cache</dt><dd>{modelState}</dd></div>
              <div><dt>CUDA</dt><dd>{bridgeModelStatus?.cuda ? 'available' : 'not available / unknown'}</dd></div>
              <div><dt>Runtime path</dt><dd>{bridgeModelStatus?.managedRuntime?.path ?? 'not checked'}</dd></div>
              <div><dt>Cache path</dt><dd>{bridgeModelStatus?.cacheDir ?? 'not checked'}</dd></div>
              <div><dt>Model folder</dt><dd>{bridgeModelFolderStatus?.active || 'auto / not set'}</dd></div>
            </dl>
            {bridgeModelStatus?.message ? <p className="field-help">{bridgeModelStatus.message}</p> : null}
            {bridgeModelError ? <p className="backend-model-error">{bridgeModelError}</p> : null}
            <div className="control-button-grid">
              <button className="btn" type="button" onClick={() => void refreshBridgeModelStatus()} disabled={bridgeModelBusy}>{Icon.pulse()} Check model</button>
              <button className="btn primary" type="button" onClick={() => void installBridgeRuntime()} disabled={bridgeModelBusy}>{Icon.download()} Install runtime + model</button>
              <button className="btn" type="button" onClick={() => void downloadBridgeModel()} disabled={bridgeModelBusy || !bridgeModelStatus?.dependenciesReady}>{Icon.download()} Download model</button>
              <button className="btn" type="button" onClick={() => void Promise.all([refreshShelfFromBridge(), refreshModelFolderStatus()])}>{Icon.folder()} Refresh folders</button>
            </div>
            <p className="field-help">Repair runtime is scaffolded here: delete `%LOCALAPPDATA%\\LumenDeck\\diffusers-runtime` manually, then install again.</p>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>General</h2>
              <span className="chip">{appSettings.themeMode}</span>
            </div>
            <label className="field">
              <span className="field-label">Theme mode</span>
              <select value={appSettings.themeMode} onChange={(event) => updateAppSettings({ themeMode: event.target.value as AppSettings['themeMode'] })}>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </label>
            <label className="field-inline">
              <span><span className="field-label">Compact mode</span><span className="field-help">Reduces page spacing for dense work sessions.</span></span>
              <button className="switch" type="button" role="switch" aria-checked={appSettings.compactMode}
                onClick={() => updateAppSettings({ compactMode: !appSettings.compactMode })} />
            </label>
            <label className="field">
              <span className="field-label">Startup behavior</span>
              <select value={appSettings.startupBehavior} onChange={(event) => updateAppSettings({ startupBehavior: event.target.value as AppSettings['startupBehavior'] })}>
                <option value="guide">Open Guide</option>
                <option value="controls">Open Controls</option>
                <option value="last-view">Restore last view</option>
              </select>
            </label>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Paths</h2>
              <span className="chip">{bridgeModelFolderStatus?.usingDemo ? 'demo' : 'local'}</span>
            </div>
            <label className="field">
              <span className="field-label">Model directory</span>
              <input value={appSettings.modelDirectory} placeholder={bridgeModelFolderStatus?.active || 'Use Model Shelf to connect a folder'}
                onChange={(event) => updateAppSettings({ modelDirectory: event.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">LoRA directory</span>
              <input value={appSettings.loraDirectory} placeholder="Optional; usually inside the model folder"
                onChange={(event) => updateAppSettings({ loraDirectory: event.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Output directory</span>
              <input value={appSettings.outputDirectory} placeholder="Not connected to native picker yet"
                onChange={(event) => updateAppSettings({ outputDirectory: event.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Cache directory</span>
              <input value={appSettings.cacheDirectory} placeholder="Backend default"
                onChange={(event) => updateAppSettings({ cacheDirectory: event.target.value })} />
            </label>
            <p className="field-help">Directory text fields are saved locally. Native folder pickers are not connected yet.</p>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Performance</h2>
              <span className="chip">{appSettings.vramSafetyMode}</span>
            </div>
            <label className="field">
              <span className="field-label">Preferred backend</span>
              <select value={backendSettings.selectedBackend} onChange={(event) => setPreferredBackend(event.target.value as RenderBackendId)}>
                <option value="mock">Built-in mock</option>
                <option value="bridge">Local Diffusers bridge</option>
                <option value="comfyui">ComfyUI API</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">VRAM safety mode</span>
              <select value={appSettings.vramSafetyMode} onChange={(event) => updateAppSettings({ vramSafetyMode: event.target.value as AppSettings['vramSafetyMode'] })}>
                <option value="strict">Strict</option>
                <option value="balanced">Balanced</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Max concurrent jobs</span>
              <input type="number" min={1} max={4} value={appSettings.maxConcurrentJobs}
                onChange={(event) => updateAppSettings({ maxConcurrentJobs: Number(event.target.value) })} />
            </label>
            <label className="field">
              <span className="field-label">TurboForge acceleration profile</span>
              <select value={appSettings.turboAccelerationProfile} onChange={(event) => setAccelerationProfile(event.target.value as TurboPresetId)}>
                {Object.values(TURBO_PRESETS).map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.beginnerLabel}</option>
                ))}
              </select>
            </label>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Privacy / Local Mode</h2>
              <span className="chip clean">local only</span>
            </div>
            <dl className="page-metrics">
              <div><dt>Local-only mode</dt><dd>{appSettings.localOnlyMode ? 'Enabled' : 'Disabled'}</dd></div>
              <div><dt>Telemetry</dt><dd>{appSettings.telemetryDisabled ? 'Disabled' : 'Enabled'}</dd></div>
              <div><dt>Stored gallery</dt><dd>{storage.persistenceMode}</dd></div>
              <div><dt>Gallery size</dt><dd>{storage.itemCount} items, about {storage.approximateLabel}</dd></div>
              <div><dt>Desktop gallery path</dt><dd>{storage.plannedDesktopPath}</dd></div>
            </dl>
            {storage.warning ? <p className="field-help">{storage.warning}</p> : null}
            <p className="field-help">Filesystem gallery storage is planned with renders, manifests, and thumbnails subfolders. Current web/dev mode uses browser storage.</p>
            <button className="btn" type="button" onClick={confirmClearLocalHistory}>
              {Icon.trash()} Clear local history
            </button>
          </article>

          <article className="card page-card">
            <div className="page-card-head">
              <h2>Developer / Diagnostics</h2>
              <span className={`chip ${appSettings.showDiagnostics ? 'warnings' : ''}`}>{appSettings.showDiagnostics ? 'shown' : 'hidden'}</span>
            </div>
            <label className="field-inline">
              <span><span className="field-label">Show diagnostics</span><span className="field-help">Shows additional status text in settings-oriented screens.</span></span>
              <button className="switch" type="button" role="switch" aria-checked={appSettings.showDiagnostics}
                onClick={() => updateAppSettings({ showDiagnostics: !appSettings.showDiagnostics })} />
            </label>
            <div className="control-button-grid">
              <button className="btn" type="button" onClick={() => setControlStatus('Debug bundle export is not connected yet.')}>
                Export debug bundle
              </button>
              <button className="btn" type="button" onClick={confirmResetSettings}>
                Reset settings
              </button>
              <button className="btn" type="button" onClick={() => setView('diagnostics')}>
                Open Diagnostics
              </button>
            </div>
            {appSettings.showDiagnostics ? (
              <dl className="page-metrics">
                <div><dt>Backend URL</dt><dd>{backendSettings.selectedBackend === 'bridge' ? backendSettings.bridgeUrl : backendSettings.comfyUrl}</dd></div>
                <div><dt>Fallback</dt><dd>{backendSettings.fallbackToMock ? 'Enabled' : 'Disabled'}</dd></div>
                <div><dt>Default profile</dt><dd>{DEFAULT_APP_SETTINGS.turboAccelerationProfile}</dd></div>
              </dl>
            ) : null}
          </article>

          <article className="card page-card wide">
            <div className="page-card-head">
              <h2>API / Integrations</h2>
              <span className="chip">masked</span>
            </div>
            <div className="settings-secret-grid">
              <SecretField id="civitai-key" label="Civitai API key" value={appSettings.apiKeys.civitai}
                onChange={(value) => updateApiKey('civitai', value)} />
              <SecretField id="hf-key" label="Hugging Face token" value={appSettings.apiKeys.huggingface}
                onChange={(value) => updateApiKey('huggingface', value)} />
              <SecretField id="custom-api-key" label="Custom endpoint key" value={appSettings.apiKeys.customEndpoint}
                onChange={(value) => updateApiKey('customEndpoint', value)} />
            </div>
            <p className="field-help">
              Secrets are masked by default and are never logged by this UI. Values are stored only in local persistence when you enter them here.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
