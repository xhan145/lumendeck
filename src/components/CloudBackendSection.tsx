import { useEffect, useState } from 'react';
import type { CloudProviderInfo } from '../bridge/cloudAdapter';
import { cloudAdapter, useStudio } from '../state/store';
import { Icon } from './icons';

/**
 * Cloud backend configuration: provider + curated model pickers and a
 * per-provider API-key field. The key is POSTed straight to the LOCAL bridge
 * (settings.json) and never enters the store or localStorage.
 */
export function CloudBackendSection() {
  const backendSettings = useStudio((s) => s.backendSettings);
  const updateBackendSettings = useStudio((s) => s.updateBackendSettings);
  const [providers, setProviders] = useState<CloudProviderInfo[] | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cloudAdapter.setBaseUrl(backendSettings.bridgeUrl);
    cloudAdapter
      .listProviders()
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        setError(null);
      })
      .catch((exc: unknown) => {
        if (cancelled) return;
        setProviders([]);
        setError(
          `Bridge unreachable (${exc instanceof Error ? exc.message : String(exc)}). ` +
            'The Cloud backend calls providers through the local bridge — start LumenDeck’s bridge first.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [backendSettings.bridgeUrl]);

  const chosen = providers?.find((p) => p.id === backendSettings.cloudProvider) ?? null;
  const models = chosen?.models ?? [];
  const modelValue = models.some((m) => m.id === backendSettings.cloudModel) ? backendSettings.cloudModel : '';

  const saveKey = async (value: string) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hasKey = await cloudAdapter.saveKey(chosen.id, value);
      setKeyDraft('');
      setNotice(hasKey ? 'Key saved on the local bridge.' : 'Key cleared.');
      cloudAdapter.setBaseUrl(backendSettings.bridgeUrl);
      setProviders(await cloudAdapter.listProviders());
    } catch (exc: unknown) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cloud-backend-section">
      <label className="field">
        <span className="field-label">Cloud provider</span>
        <select
          value={backendSettings.cloudProvider}
          onChange={(event) => {
            const id = event.target.value;
            const next = providers?.find((p) => p.id === id);
            updateBackendSettings({ cloudProvider: id, cloudModel: next?.models[0]?.id ?? '' });
          }}
        >
          {(providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.hasKey ? ' — key saved' : ''}
            </option>
          ))}
          {providers === null ? <option value={backendSettings.cloudProvider}>loading…</option> : null}
        </select>
        <span className="field-help">All calls go through the local bridge; your key never enters the browser.</span>
      </label>

      <label className="field">
        <span className="field-label">Model</span>
        <select value={modelValue} onChange={(event) => updateBackendSettings({ cloudModel: event.target.value })}>
          <option value="" disabled>
            pick a model…
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.kind})
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">{chosen ? `${chosen.label} API key` : 'API key'}</span>
        <input
          type="password"
          value={keyDraft}
          placeholder={chosen?.hasKey ? 'key saved — paste to replace' : 'paste your API key'}
          autoComplete="off"
          onChange={(event) => setKeyDraft(event.target.value)}
        />
        <span className="field-help">Stored in the bridge&apos;s settings.json on this machine only.</span>
      </label>
      <div className="turbo-actions">
        <button
          className="btn primary"
          type="button"
          disabled={busy || !chosen || !keyDraft.trim()}
          onClick={() => void saveKey(keyDraft.trim())}
        >
          {Icon.download()} {busy ? 'Saving…' : 'Save key'}
        </button>
        <button className="btn" type="button" disabled={busy || !chosen?.hasKey} onClick={() => void saveKey('')}>
          Clear key
        </button>
      </div>

      {chosen && !chosen.hasKey ? (
        <div className="backend-health status-degraded" role="status">
          <strong>no key</strong>
          <span>No API key saved for {chosen.label} — cloud renders will fail until you add one.</span>
        </div>
      ) : null}
      {notice ? <p className="field-help">{notice}</p> : null}
      {error ? <p className="backend-model-error">{error}</p> : null}
    </div>
  );
}
