import { useMemo, useState } from 'react';
import { useStudio, type GalleryItem } from '../../state/store';
import { buildAnalysisContext } from '../../state/creative';
import { buildLineages, diffPrompts, diffSettings, MAX_LINEAGES } from '../../core/creative/promptLineage';
import { tokenizePrompt } from '../../core/creative/craftBrain';
import { Icon } from '../icons';

function promptOf(item: GalleryItem): string {
  return item.manifest?.resolvedPrompt || item.manifest?.prompt || '';
}

export function PromptLineage() {
  const gallery = useStudio((s) => s.gallery);
  const brains = useStudio((s) => s.creative.brains);
  const shelf = useStudio((s) => s.shelf);
  const restoreSnapshot = useStudio((s) => s.restoreSnapshot);
  const promoteToRecipe = useStudio((s) => s.promoteToRecipe);
  const [openId, setOpenId] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);

  const renders = useMemo(() => buildAnalysisContext(gallery, brains, shelf).renders, [gallery, brains, shelf]);
  const lineages = useMemo(() => buildLineages(renders), [renders]);
  const byId = useMemo(() => {
    const m = new Map<string, GalleryItem>();
    for (const g of gallery) m.set(g.id, g);
    return m;
  }, [gallery]);

  const shown = lineages.slice(0, MAX_LINEAGES);

  const toggleCompare = (id: string) => {
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 2 ? [c[1], id] : [...c, id]));
  };

  if (lineages.length === 0) {
    return (
      <section className="card creative-card"><p className="creative-empty">Not enough related renders yet — keep iterating on prompts and their evolution shows up here.</p></section>
    );
  }

  const [aId, bId] = compare;
  const aItem = aId ? byId.get(aId) : undefined;
  const bItem = bId ? byId.get(bId) : undefined;
  const aRender = aId ? renders.find((r) => r.id === aId) : undefined;
  const bRender = bId ? renders.find((r) => r.id === bId) : undefined;

  return (
    <>
      {lineages.length > MAX_LINEAGES ? (
        <p className="craft-note">Showing {MAX_LINEAGES} of {lineages.length} lineages (largest first).</p>
      ) : null}

      {aItem && bItem && aRender && bRender ? (
        <section className="card creative-card lineage-compare">
          <div className="creative-card-head"><h3>{Icon.scatter({ size: 15 })} Compare</h3><span className="spacer" /><button className="btn tiny" type="button" onClick={() => setCompare([])}>Clear</button></div>
          <div className="lineage-compare-grid">
            <figure><img src={aItem.dataUrl} alt="A" /><figcaption>{promptOf(aItem).slice(0, 80)}</figcaption></figure>
            <figure><img src={bItem.dataUrl} alt="B" /><figcaption>{promptOf(bItem).slice(0, 80)}</figcaption></figure>
          </div>
          {(() => {
            const d = diffPrompts(tokenizePrompt(promptOf(aItem)), tokenizePrompt(promptOf(bItem)));
            const sd = diffSettings(aRender, bRender);
            return (
              <div className="lineage-diff">
                {d.added.map((t) => <span key={`+${t}`} className="chip diff-add">+{t}</span>)}
                {d.removed.map((t) => <span key={`-${t}`} className="chip diff-rem">−{t}</span>)}
                {sd.map((s) => <span key={s.key} className="chip">{s.key} {s.from}→{s.to}</span>)}
              </div>
            );
          })()}
        </section>
      ) : (
        <p className="craft-note">Tip: click two thumbnails to compare them side-by-side.</p>
      )}

      <div className="lineage-list">
        {shown.map((ln) => {
          const items = ln.renderIds.map((id) => byId.get(id)).filter(Boolean) as GalleryItem[];
          if (items.length < 2) return null; // deleted renders collapsed the line
          const open = openId === ln.id;
          return (
            <section key={ln.id} className="card creative-card lineage-row">
              <div className="creative-card-head">
                <h3>{Icon.sparkle({ size: 14 })} {ln.spine.length ? ln.spine.slice(0, 4).join(', ') : 'Prompt line'}</h3>
                <span className="chip">{ln.size}</span>
                <span className="spacer" />
                {ln.spine.length ? <button className="btn tiny" type="button" onClick={() => promoteToRecipe({ text: ln.spine.join(', '), name: `Line: ${ln.spine.slice(0, 3).join(', ')}` })}>Make recipe</button> : null}
                <button className="btn tiny" type="button" onClick={() => setOpenId(open ? null : ln.id)}>{open ? 'Collapse' : 'Timeline'}</button>
              </div>
              <div className="lineage-strip">
                {ln.renderIds.map((id, i) => {
                  const it = byId.get(id);
                  if (!it) return null;
                  const step = ln.steps[i];
                  return (
                    <div key={id} className={`lineage-thumb ${compare.includes(id) ? 'sel' : ''}`}>
                      <button type="button" onClick={() => toggleCompare(id)} title="Click to compare">
                        <img src={it.dataUrl} alt={`step ${i + 1}`} />
                      </button>
                      {open && (step.added.length || step.removed.length) ? (
                        <div className="lineage-stepdiff">
                          {step.added.map((t) => <span key={`+${t}`} className="chip diff-add">+{t}</span>)}
                          {step.removed.map((t) => <span key={`-${t}`} className="chip diff-rem">−{t}</span>)}
                        </div>
                      ) : null}
                      {open ? (
                        <button className="btn tiny" type="button" onClick={() => restoreSnapshot(it)}>Restore</button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
