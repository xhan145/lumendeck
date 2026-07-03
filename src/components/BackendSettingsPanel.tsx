import type { BridgeRenderer, RenderBackendId } from '../turboForge/backends/backendSettings';
import { useStudio } from '../state/store';
import { Icon } from './icons';

export function BackendSettingsPanel() {
  const { backendSettings, setAdapter, updateBackendSettings, testSelectedBackend } = useStudio();
  const health = backendSettings.lastHealth;

  return (
    <section className="rail-section backend-panel" aria-labelledby="backend-settings-title">
      <h3 id="backend-settings-title">{Icon.plug()} Backend</h3>
      <p className="turbo-copy">
        Mock works offline. ComfyUI requires a local ComfyUI server running with API access.
      </p>

      <label className="field">
        <span className="field-label">Selected backend</span>
        <select value={backendSettings.selectedBackend} onChange={(event) => setAdapter(event.target.value as RenderBackendId)}>
          <option value="mock">Mock: built-in renderer</option>
          <option value="comfyui">ComfyUI API</option>
          <option value="bridge">Diffusers bridge</option>
        </select>
      </label>

      {backendSettings.selectedBackend === 'comfyui' ? (
        <label className="field">
          <span className="field-label">ComfyUI URL</span>
          <input
            value={backendSettings.comfyUrl}
            placeholder="http://127.0.0.1:8188"
            onChange={(event) => updateBackendSettings({ comfyUrl: event.target.value })}
          />
          <span className="field-help">Start ComfyUI first, then use this URL to test `/system_stats`.</span>
        </label>
      ) : null}

      {backendSettings.selectedBackend === 'bridge' ? (
        <>
          <label className="field">
            <span className="field-label">Diffusers bridge URL</span>
            <input
              value={backendSettings.bridgeUrl}
              placeholder="http://127.0.0.1:8787"
              onChange={(event) => updateBackendSettings({ bridgeUrl: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Bridge renderer</span>
            <select
              value={backendSettings.bridgeRenderer}
              onChange={(event) => updateBackendSettings({ bridgeRenderer: event.target.value as BridgeRenderer })}
            >
              <option value="auto">Auto (real if available, else procedural)</option>
              <option value="procedural">Procedural (always works, offline)</option>
              <option value="diffusers">Diffusers (real SD-Turbo; needs torch on the bridge)</option>
            </select>
            <span className="field-help">Diffusers downloads a model on first use; procedural is instant and offline.</span>
          </label>
        </>
      ) : null}

      <label className="field-inline">
        <span>
          <span className="field-label">Fallback to mock</span>
          <span className="field-help">Keeps renders working when the real backend is offline.</span>
        </span>
        <input
          type="checkbox"
          checked={backendSettings.fallbackToMock}
          onChange={(event) => updateBackendSettings({ fallbackToMock: event.target.checked })}
        />
      </label>

      <button className="btn" type="button" onClick={() => void testSelectedBackend()}>
        {Icon.pulse()} Test connection
      </button>

      {health ? (
        <div className={`backend-health status-${health.status}`} role="status" aria-live="polite">
          <strong>{health.status}</strong>
          <span>{health.message}</span>
          <span className="mono">{health.elapsedMs} ms</span>
        </div>
      ) : (
        <div className="backend-health status-degraded">
          <strong>not tested</strong>
          <span>Test the selected backend before a real render.</span>
        </div>
      )}
    </section>
  );
}
