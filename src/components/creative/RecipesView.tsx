import { useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import { Icon } from '../icons';
import type { AspectKey, CreativeRecipe, ExportTarget } from '../../core/creative/types';
import { resolveRecipePrompt } from '../../core/creative/recipes';
import '../../styles/creative.css';

const ALL_ASPECTS: AspectKey[] = ['16:9', '1:1', '9:16'];
const ALL_TARGETS: ExportTarget[] = ['github', 'itch', 'x', 'instagram', 'shopify', 'print', 'web'];

function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="tag-input">
      <div className="tag-chips">
        {value.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>{Icon.close({ size: 11 })}</button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

function RecipeEditor({ recipe, onClose }: { recipe: CreativeRecipe; onClose: () => void }) {
  const update = useStudio((s) => s.updateCreativeRecipe);
  const shelf = useStudio((s) => s.shelf);
  const [subject, setSubject] = useState('');
  const set = (patch: Partial<CreativeRecipe>) => update(recipe.id, patch);
  const preview = resolveRecipePrompt(recipe, subject);

  return (
    <div className="recipe-editor card creative-card">
      <div className="creative-card-head">
        <h3>{Icon.beaker({ size: 15 })} Edit recipe</h3>
        <span className="spacer" />
        <button className="btn icon" type="button" aria-label="Close editor" onClick={onClose}>{Icon.close({ size: 16 })}</button>
      </div>
      <label className="field"><span className="field-label">Name</span>
        <input value={recipe.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="field"><span className="field-label">Persona</span>
        <input value={recipe.persona} placeholder="e.g. Bold indie art director" onChange={(e) => set({ persona: e.target.value })} />
      </label>
      <div className="field"><span className="field-label">Style tags</span>
        <TagInput value={recipe.styleTags} onChange={(v) => set({ styleTags: v })} placeholder="add a style tag…" />
      </div>
      <label className="field"><span className="field-label">Model</span>
        <select value={recipe.modelId} onChange={(e) => set({ modelId: e.target.value })}>
          <option value="">Keep current model</option>
          {shelf.filter((m) => m.assetType === 'checkpoint').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label className="field"><span className="field-label">Prompt template <span className="field-help">use {'{subject}'} as a placeholder</span></span>
        <textarea rows={2} value={recipe.promptTemplate} onChange={(e) => set({ promptTemplate: e.target.value })} />
      </label>
      <label className="field"><span className="field-label">Negative prompt</span>
        <textarea rows={2} value={recipe.negativePrompt} onChange={(e) => set({ negativePrompt: e.target.value })} />
      </label>
      <div className="field"><span className="field-label">Aspect ratios</span>
        <div className="chip-row">
          {ALL_ASPECTS.map((a) => (
            <button key={a} type="button" className={`chip toggle ${recipe.aspectRatios.includes(a) ? 'on' : ''}`}
              onClick={() => set({ aspectRatios: recipe.aspectRatios.includes(a) ? recipe.aspectRatios.filter((x) => x !== a) : [...recipe.aspectRatios, a] })}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="field"><span className="field-label">Export targets</span>
        <div className="chip-row">
          {ALL_TARGETS.map((t) => (
            <button key={t} type="button" className={`chip toggle ${recipe.exportTargets.includes(t) ? 'on' : ''}`}
              onClick={() => set({ exportTargets: recipe.exportTargets.includes(t) ? recipe.exportTargets.filter((x) => x !== t) : [...recipe.exportTargets, t] })}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="field"><span className="field-label">Brand colors</span>
        <TagInput value={recipe.brandColors} onChange={(v) => set({ brandColors: v })} placeholder="#34d6f4" />
      </div>
      <label className="field"><span className="field-label">Success score: {recipe.successScore}/5</span>
        <input type="range" min={0} max={5} step={1} value={recipe.successScore} onChange={(e) => set({ successScore: Number(e.target.value) })} />
      </label>
      <div className="recipe-preview">
        <input className="recipe-subject" value={subject} placeholder="Try a subject to preview…" onChange={(e) => setSubject(e.target.value)} />
        <p className="recipe-preview-text">{preview || 'Prompt preview appears here.'}</p>
      </div>
    </div>
  );
}

function RecipeCard({ recipe, onEdit }: { recipe: CreativeRecipe; onEdit: () => void }) {
  const duplicate = useStudio((s) => s.duplicateCreativeRecipe);
  const remove = useStudio((s) => s.deleteCreativeRecipe);
  const apply = useStudio((s) => s.applyCreativeRecipe);
  return (
    <article className="card creative-card recipe-tile" style={{ ['--r-accent' as string]: recipe.brandColors[0] ?? 'var(--ld-accent)' } as React.CSSProperties}>
      <div className="recipe-tile-swatches" aria-hidden="true">
        {(recipe.brandColors.length ? recipe.brandColors : ['var(--ld-accent)', 'var(--ld-violet)']).slice(0, 4).map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </div>
      <h3 className="recipe-tile-name">{recipe.name}</h3>
      {recipe.persona ? <p className="recipe-tile-persona">{recipe.persona}</p> : null}
      <div className="recipe-tile-tags">
        {recipe.styleTags.slice(0, 4).map((t) => <span key={t} className="mini-tag">{t}</span>)}
        {recipe.styleTags.length > 4 ? <span className="mini-tag">+{recipe.styleTags.length - 4}</span> : null}
      </div>
      <div className="recipe-tile-meta">
        <span title="Success score">{Icon.sparkle({ size: 12 })} {recipe.successScore}/5</span>
        <span title="Times used">{Icon.play({ size: 12 })} {recipe.timesUsed}×</span>
        <span>{recipe.aspectRatios.join(' · ')}</span>
      </div>
      <div className="recipe-tile-actions">
        <button className="btn tiny primary" type="button" onClick={() => apply(recipe.id, '')}>{Icon.bolt({ size: 12 })} Apply</button>
        <button className="btn tiny" type="button" onClick={onEdit}>{Icon.edit({ size: 12 })} Edit</button>
        <button className="btn tiny" type="button" onClick={() => duplicate(recipe.id)}>{Icon.copy({ size: 12 })}</button>
        <button className="btn tiny danger" type="button" aria-label="Delete recipe" onClick={() => remove(recipe.id)}>{Icon.trash({ size: 12 })}</button>
      </div>
    </article>
  );
}

/** Creative Recipes: view / create / edit / duplicate / apply. */
export function RecipesView() {
  const recipes = useStudio((s) => s.creative.recipes);
  const create = useStudio((s) => s.createCreativeRecipe);
  const [editing, setEditing] = useState<string | null>(null);
  const editingRecipe = useMemo(() => recipes.find((r) => r.id === editing) ?? null, [recipes, editing]);

  return (
    <main className="studio-page creative-page recipes-page scroll" aria-label="Creative Recipes">
      <div className="studio-page-inner">
        <header className="creative-hero">
          <div>
            <p className="page-kicker">Creative Recipes</p>
            <h1>{Icon.beaker({ size: 22 })} Reusable formulas</h1>
            <p className="creative-lead">Persona + style + model + prompt scaffolds you can apply to any workflow in one click.</p>
          </div>
          <button className="btn primary" type="button" onClick={() => setEditing(create('New Recipe'))}>{Icon.plus({ size: 16 })} New recipe</button>
        </header>

        <div className={`recipes-layout ${editingRecipe ? 'editing' : ''}`}>
          <section className="recipes-grid">
            {recipes.length === 0 ? (
              <div className="card creative-card creative-empty-card">
                <span aria-hidden="true">{Icon.beaker({ size: 32 })}</span>
                <p>No recipes yet. Create one, or promote a render to a recipe from the gallery or constellation.</p>
              </div>
            ) : (
              recipes.map((r) => <RecipeCard key={r.id} recipe={r} onEdit={() => setEditing(r.id)} />)
            )}
          </section>
          {editingRecipe ? <RecipeEditor recipe={editingRecipe} onClose={() => setEditing(null)} /> : null}
        </div>
      </div>
    </main>
  );
}
