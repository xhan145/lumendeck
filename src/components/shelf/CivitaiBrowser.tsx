import { useState } from 'react';
import type { CivitaiResult } from '../../bridge/httpAdapter';
import { httpAdapter, useStudio } from '../../state/store';
import { Icon } from '../icons';

type CivitaiType = 'Checkpoint' | 'LORA';
const TOKEN_KEY = 'lumendeck.civitaiToken';

function sizeLabel(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${Math.round(kb)} KB`;
}

/** Browse and download checkpoints/LoRAs from Civitai straight into the model folder. */
export function CivitaiBrowser() {
  const refreshShelf = useStudio((s) => s.refreshShelfFromBridge);
  const refreshFolder = useStudio((s) => s.refreshModelFolderStatus);

  const [query, setQuery] = useState('');
  const [type, setType] = useState<CivitaiType>('Checkpoint');
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [results, setResults] = useState<CivitaiResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Record<number, number>>({}); // versionId -> pct
  const [done, setDone] = useState<Record<number, boolean>>({});

  const persistToken = (value: string) => {
    setToken(value);
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  };

  const search = async () => {
    setLoading(true);
    setError(null);
    try {
      setResults(await httpAdapter.civitaiSearch(query, type, token));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const download = async (item: CivitaiResult) => {
    setError(null);
    setDownloading((d) => ({ ...d, [item.versionId]: 0 }));
    try {
      await httpAdapter.civitaiDownload(item, token, (received, total) => {
        const pct = total > 0 ? Math.round((received / total) * 100) : 0;
        setDownloading((d) => ({ ...d, [item.versionId]: pct }));
      });
      setDone((d) => ({ ...d, [item.versionId]: true }));
      await refreshFolder();
      await refreshShelf();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading((d) => {
        const next = { ...d };
        delete next[item.versionId];
        return next;
      });
    }
  };

  return (
    <section className="shelf-folder civitai" aria-label="Download from Civitai">
      <div className="shelf-folder-copy">
        <h3>{Icon.download({ size: 16 })} Get models from Civitai</h3>
        <p>Search Civitai and download checkpoints or LoRAs straight into your model folder. Large models take a while.</p>
      </div>
      <div className="civitai-controls">
        <div className="civitai-searchbar">
          <div className="civitai-type" role="group" aria-label="Model type">
            {(['Checkpoint', 'LORA'] as CivitaiType[]).map((t) => (
              <button key={t} className="chip filter-chip" aria-pressed={type === t} onClick={() => setType(t)}>
                {t === 'LORA' ? 'LoRAs' : 'Checkpoints'}
              </button>
            ))}
          </div>
          <input
            value={query}
            placeholder="Search Civitai (e.g. realistic, anime, pony)…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            aria-label="Civitai search query"
          />
          <button className="btn primary" type="button" disabled={loading} onClick={() => void search()}>
            {loading ? 'Searching…' : <>{Icon.pulse({ size: 14 })} Search</>}
          </button>
        </div>
        <details className="civitai-token">
          <summary>API token (optional — needed for some downloads)</summary>
          <input
            type="password"
            value={token}
            placeholder="Civitai API token"
            onChange={(e) => persistToken(e.target.value)}
            aria-label="Civitai API token"
          />
          <span className="field-help">Create one at civitai.com → Account → API Keys. Stored locally in this browser.</span>
        </details>
        {error ? <p className="backend-model-error">{error}</p> : null}
      </div>

      {results.length > 0 ? (
        <div className="civitai-grid">
          {results.map((item) => {
            const pct = downloading[item.versionId];
            const busy = pct !== undefined;
            return (
              <article key={item.versionId} className="card civitai-card">
                <div className="civitai-thumb">
                  {item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <div className="civitai-thumb-empty">{Icon.image({ size: 22 })}</div>}
                  {item.nsfw ? <span className="civitai-nsfw">NSFW</span> : null}
                </div>
                <div className="civitai-meta">
                  <h4 title={item.name}>{item.name}</h4>
                  <div className="civitai-chips">
                    <span className="chip">{item.baseModel || item.type}</span>
                    <span className="chip">{sizeLabel(item.sizeKB)}</span>
                  </div>
                  {busy ? (
                    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                      <div style={{ width: `${pct}%` }} />
                    </div>
                  ) : done[item.versionId] ? (
                    <span className="in-use">{Icon.ok({ size: 14 })} Downloaded</span>
                  ) : (
                    <button className="btn" type="button" onClick={() => void download(item)}>
                      {Icon.download({ size: 14 })} Download
                    </button>
                  )}
                  {busy ? <span className="field-help">{pct}%</span> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
