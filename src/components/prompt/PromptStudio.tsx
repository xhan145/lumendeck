import { useMemo, useState } from 'react';
import { visiblePresets, type PromptPreset } from '../../core/prompt/presets';
import { expandWildcards, mulberry32, type WildcardSet } from '../../core/prompt/wildcards';
import { search as searchHistory } from '../../core/prompt/history';
import { defaultAssistant, mergeNegatives, type EnhanceResult } from '../../core/prompt/enhance';
import { findNode, uid } from '../../core/workflow';
import { useStudio } from '../../state/store';
import { buildAnalysisContext } from '../../state/creative';
import { analyzeCraft } from '../../core/creative/craftBrain';
import { buildLineages } from '../../core/creative/promptLineage';
import { coach, appendTokens, type CoachSuggestion } from '../../core/creative/promptCoach';
import { Icon } from '../icons';

type Tab = 'library' | 'wildcards' | 'history' | 'enhance' | 'coach';

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'wildcards', label: 'Wildcards' },
  { id: 'history', label: 'History' },
  { id: 'enhance', label: 'Enhance' },
  { id: 'coach', label: 'Coach' },
];

/**
 * Prompt Studio — collapsible panel with four cooperating tools (Library,
 * Wildcards, History, Enhance). Mirrors the LoRA/ControlNet rack visual language
 * and consumes the pure core modules through the persisted store slice.
 */
export function PromptStudio() {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>('library');

  return (
    <section className="rail-section prompt-studio">
      <h3>
        <button
          type="button"
          className="ps-toggle"
          aria-expanded={open}
          aria-controls="prompt-studio-body"
          onClick={() => setOpen((v) => !v)}
        >
          {Icon.bolt({ size: 14 })} Prompt Studio
        </button>
      </h3>
      {open ? (
        <div id="prompt-studio-body" className="rack">
          <div className="ps-tabs" role="tablist" aria-label="Prompt Studio tools">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`ps-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`ps-panel-${t.id}`}
                className={`ps-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="ps-panel" role="tabpanel" id={`ps-panel-${tab}`} aria-labelledby={`ps-tab-${tab}`}>
            {tab === 'library' ? <LibraryTab /> : null}
            {tab === 'wildcards' ? <WildcardsTab /> : null}
            {tab === 'history' ? <HistoryTab /> : null}
            {tab === 'enhance' ? <EnhanceTab /> : null}
            {tab === 'coach' ? <CoachTab /> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Prompt Coach: append-only suggestions from the user's own craft history. */
function CoachTab() {
  const workflow = useStudio((s) => s.workflow);
  const updateParam = useStudio((s) => s.updateParam);
  const applyCreativeRecipe = useStudio((s) => s.applyCreativeRecipe);
  const gallery = useStudio((s) => s.gallery);
  const brains = useStudio((s) => s.creative.brains);
  const recipes = useStudio((s) => s.creative.recipes);
  const shelf = useStudio((s) => s.shelf);

  const promptNode = findNode(workflow, 'prompt');
  const positive = String(promptNode?.params.positive ?? '');

  const suggestions = useMemo(() => {
    const renders = buildAnalysisContext(gallery, brains, shelf).renders;
    return coach(positive, analyzeCraft(renders, recipes, new Date()), buildLineages(renders), recipes);
  }, [positive, gallery, brains, shelf, recipes]);

  const apply = (s: CoachSuggestion) => {
    if (s.kind === 'apply-recipe' && s.recipeId) {
      applyCreativeRecipe(s.recipeId, positive);
      return;
    }
    if (!promptNode || s.tokens.length === 0) return;
    updateParam(promptNode.id, 'positive', appendTokens(positive, s.tokens));
  };

  if (suggestions.length === 0) {
    return <p className="field-help">Keep creating — suggestions appear here as your craft history grows.</p>;
  }
  return (
    <div className="ps-coach" role="list">
      {suggestions.map((s, i) => (
        <button key={`${s.kind}:${s.label}:${i}`} type="button" role="listitem" className={`ps-coach-item ${s.kind}`} onClick={() => apply(s)} title="Append to your prompt (never overwrites)">
          <span className="ps-coach-glyph" aria-hidden="true">{s.kind === 'add-token' ? '+' : s.kind === 'apply-line' ? '≈' : '▸'}</span>
          <span className="ps-coach-label">{s.label}</span>
          <span className="ps-coach-reason">{s.reason}</span>
        </button>
      ))}
    </div>
  );
}

function LibraryTab() {
  const presets = useStudio((s) => s.promptTools.presets);
  const applyPreset = useStudio((s) => s.applyPreset);
  const savePreset = useStudio((s) => s.savePreset);
  const deletePreset = useStudio((s) => s.deletePreset);
  const workflow = useStudio((s) => s.workflow);

  const [name, setName] = useState('');
  const [includeSettings, setIncludeSettings] = useState(false);
  const shown = useMemo(() => visiblePresets(presets), [presets]);

  const saveCurrent = () => {
    const prompt = findNode(workflow, 'prompt');
    const sampler = findNode(workflow, 'sampler');
    const preset: PromptPreset = {
      id: uid('preset'),
      name: name.trim() || `Preset ${shown.length + 1}`,
      positive: String(prompt?.params.positive ?? ''),
      negative: String(prompt?.params.negative ?? ''),
      settings: includeSettings && sampler
        ? {
            steps: Number(sampler.params.steps),
            cfg: Number(sampler.params.cfg),
            sampler: String(sampler.params.sampler),
            scheduler: String(sampler.params.scheduler),
          }
        : undefined,
      createdAt: new Date().toISOString(),
    };
    savePreset(preset);
    setName('');
  };

  return (
    <div className="ps-library">
      <div className="ps-save-row">
        <input
          value={name}
          placeholder="Save current as preset…"
          aria-label="New preset name"
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn" type="button" onClick={saveCurrent}>
          {Icon.save({ size: 14 })} Save
        </button>
      </div>
      <label className="ps-check">
        <input type="checkbox" checked={includeSettings} onChange={(e) => setIncludeSettings(e.target.checked)} />
        <span>Include sampler settings (steps, CFG, sampler, scheduler)</span>
      </label>

      {shown.length === 0 ? (
        <p className="field-help">No presets yet. Save the current prompt to start your library.</p>
      ) : (
        <div className="ps-preset-grid">
          {shown.map((p) => (
            <div key={p.id} className="ps-preset-card">
              <div className="ps-preset-head">
                <span className="ps-preset-name" title={p.name}>{p.name}</span>
                {p.builtin ? <span className="chip ps-builtin">builtin</span> : null}
              </div>
              {p.tags?.length ? (
                <div className="ps-tag-row">
                  {p.tags.map((t) => <span key={t} className="ps-tag">{t}</span>)}
                </div>
              ) : null}
              <p className="ps-preset-preview" title={p.positive}>{p.positive}</p>
              <div className="ps-preset-actions">
                <button className="btn" type="button" onClick={() => applyPreset(p.id)}>Apply</button>
                <button
                  className="btn icon"
                  type="button"
                  aria-label={p.builtin ? `Hide preset ${p.name}` : `Delete preset ${p.name}`}
                  title={p.builtin ? 'Hide builtin preset' : 'Delete preset'}
                  onClick={() => deletePreset(p.id)}
                >
                  {Icon.trash({ size: 14 })}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WildcardsTab() {
  const wildcardSets = useStudio((s) => s.promptTools.wildcardSets);
  const upsertWildcardSet = useStudio((s) => s.upsertWildcardSet);
  const deleteWildcardSet = useStudio((s) => s.deleteWildcardSet);
  const workflow = useStudio((s) => s.workflow);

  const [newName, setNewName] = useState('');

  const promptText = String(findNode(workflow, 'prompt')?.params.positive ?? '');
  const preview = useMemo(
    () => expandWildcards(promptText, wildcardSets, mulberry32(1337)),
    [promptText, wildcardSets],
  );

  const editValues = (set: WildcardSet, raw: string) =>
    upsertWildcardSet({ ...set, values: raw.split('\n').map((v) => v.trim()).filter(Boolean) });

  const addSet = () => {
    const name = newName.trim();
    if (!name) return;
    upsertWildcardSet({ name, values: [] });
    setNewName('');
  };

  return (
    <div className="ps-wildcards">
      <div className="ps-preview" role="status">
        <span className="field-label">Preview expansion</span>
        <p className="ps-preview-text">{preview.resolved || 'Add __tokens__ to your prompt to preview.'}</p>
        {preview.unknown.length ? (
          <p className="rack-warning">
            {Icon.warning({ size: 14 })} Unknown tokens (left as-is): {preview.unknown.join(', ')}
          </p>
        ) : null}
      </div>

      {wildcardSets.map((set) => (
        <div key={set.name} className="ps-wc-set">
          <div className="ps-wc-head">
            <code className="ps-wc-token">__{set.name}__</code>
            {set.builtin ? <span className="chip ps-builtin">builtin</span> : null}
            <span className="spacer" />
            <button
              className="btn icon"
              type="button"
              aria-label={`Delete wildcard set ${set.name}`}
              onClick={() => deleteWildcardSet(set.name)}
            >
              {Icon.trash({ size: 14 })}
            </button>
          </div>
          <textarea
            className="ps-wc-values"
            aria-label={`Values for ${set.name}, one per line`}
            value={set.values.join('\n')}
            rows={Math.min(6, Math.max(2, set.values.length))}
            onChange={(e) => editValues(set, e.target.value)}
          />
        </div>
      ))}

      <div className="rack-add-row">
        <input
          value={newName}
          placeholder="New wildcard set name"
          aria-label="New wildcard set name"
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="btn" type="button" onClick={addSet}>{Icon.plus({ size: 14 })} Add set</button>
      </div>
    </div>
  );
}

function HistoryTab() {
  const history = useStudio((s) => s.promptTools.history);
  const toggleFavorite = useStudio((s) => s.toggleFavorite);
  const loadHistoryEntry = useStudio((s) => s.loadHistoryEntry);

  const [query, setQuery] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const results = useMemo(
    () => searchHistory(history, query, { onlyFavorites, favoritesFirst: false }),
    [history, query, onlyFavorites],
  );

  return (
    <div className="ps-history">
      <div className="ps-history-controls">
        <input
          value={query}
          placeholder="Search history…"
          aria-label="Search prompt history"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="ps-check">
          <input type="checkbox" checked={onlyFavorites} onChange={(e) => setOnlyFavorites(e.target.checked)} />
          <span>Favorites only</span>
        </label>
      </div>
      {results.length === 0 ? (
        <p className="field-help">No matching history yet. Renders appear here automatically.</p>
      ) : (
        <ul className="ps-history-list">
          {results.map((e) => (
            <li key={e.id} className="ps-history-row">
              <button
                type="button"
                className={`ps-star ${e.favorite ? 'on' : ''}`}
                role="switch"
                aria-checked={e.favorite}
                aria-label={e.favorite ? 'Unstar prompt' : 'Star prompt'}
                onClick={() => toggleFavorite(e.id)}
              >
                {e.favorite ? '★' : '☆'}
              </button>
              <div className="ps-history-body">
                <span className="ps-history-text" title={e.resolved || e.positive}>{e.resolved || e.positive}</span>
                <span className="ps-history-meta mono">seed {e.seed}{e.modelId ? ` · ${e.modelId}` : ''}</span>
              </div>
              <button className="btn" type="button" onClick={() => loadHistoryEntry(e.id)}>Load</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EnhanceTab() {
  const workflow = useStudio((s) => s.workflow);
  const updateParam = useStudio((s) => s.updateParam);

  const [result, setResult] = useState<EnhanceResult | null>(null);
  const [before, setBefore] = useState<{ positive: string; negative: string } | null>(null);

  const prompt = findNode(workflow, 'prompt');
  const positive = String(prompt?.params.positive ?? '');
  const negative = String(prompt?.params.negative ?? '');

  const runEnhance = async () => {
    const res = await defaultAssistant.enhance(positive);
    setResult(res);
    setBefore(null);
  };

  const accept = () => {
    if (!result || !prompt) return;
    setBefore({ positive, negative });
    updateParam(prompt.id, 'positive', result.positive);
    updateParam(prompt.id, 'negative', mergeNegatives(negative, result.negativeAdditions));
    setResult(null);
  };

  const undo = () => {
    if (!before || !prompt) return;
    updateParam(prompt.id, 'positive', before.positive);
    updateParam(prompt.id, 'negative', before.negative);
    setBefore(null);
  };

  return (
    <div className="ps-enhance">
      <div className="ps-enhance-actions">
        <button className="btn primary" type="button" onClick={() => void runEnhance()}>
          {Icon.bolt({ size: 14 })} Enhance prompt
        </button>
        <button className="btn" type="button" disabled title="Connect a cloud key to use an AI model (coming soon).">
          Use AI model
        </button>
        {before ? (
          <button className="btn" type="button" onClick={undo}>Undo</button>
        ) : null}
      </div>
      {result ? (
        <div className="ps-diff">
          <div>
            <span className="field-label">Enhanced prompt</span>
            <p className="ps-preview-text">{result.positive}</p>
          </div>
          {result.negativeAdditions.length ? (
            <div>
              <span className="field-label">Proposed negatives</span>
              <p className="ps-preview-text">{result.negativeAdditions.join(', ')}</p>
            </div>
          ) : null}
          <ul className="ps-notes">
            {result.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
          <div className="ps-enhance-actions">
            <button className="btn primary" type="button" onClick={accept}>Accept</button>
            <button className="btn" type="button" onClick={() => setResult(null)}>Dismiss</button>
          </div>
        </div>
      ) : (
        <p className="field-help">Runs the built-in rule-based enhancer. Idempotent and fully undoable.</p>
      )}
    </div>
  );
}
