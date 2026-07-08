import { useMemo, useState } from 'react';
import { useStudio } from '../../state/store';
import { CAPSULES } from '../../core/capsules';
import type { CapsuleKind } from '../../core/types';
import { Icon } from '../icons';
import '../../styles/creative.css';

/**
 * Floating command layer for the constellation. Appears when a node is selected
 * and turns the node into an actionable object: promote its prompt/model combo
 * to a recipe, create variants, build a release pack, inspect lineage, repair a
 * broken asset, archive the node, or jump to related missing pieces.
 *
 * Rendered by GraphWorkspace so it works over BOTH the 2D and 3D editors without
 * touching their internal interaction code. Selection is single-node in
 * LumenDeck; "merge selected nodes" is expressed as "promote this combo to a
 * recipe".
 */
export function ConstellationCommand() {
  const workflow = useStudio((s) => s.workflow);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const selectNode = useStudio((s) => s.selectNode);
  const duplicateCapsule = useStudio((s) => s.duplicateCapsule);
  const removeCapsule = useStudio((s) => s.removeCapsule);
  const promoteToRecipe = useStudio((s) => s.promoteToRecipe);
  const setView = useStudio((s) => s.setView);
  const buildPack = useStudio((s) => s.buildProjectReleasePack);
  const activeProjectId = useStudio((s) => s.creative.activeProjectId);
  const brains = useStudio((s) => s.creative.brains);

  const [showLineage, setShowLineage] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const node = useMemo(() => workflow.nodes.find((n) => n.id === selectedNodeId) ?? null, [workflow, selectedNodeId]);

  const lineage = useMemo(() => {
    if (!node) return { upstream: [] as string[], downstream: [] as string[] };
    const nodeKind = (id: string) => CAPSULES[workflow.nodes.find((n) => n.id === id)?.kind ?? ('note' as CapsuleKind)]?.title ?? id;
    const upstream = workflow.edges.filter((e) => e.to.node === node.id).map((e) => nodeKind(e.from.node));
    const downstream = workflow.edges.filter((e) => e.from.node === node.id).map((e) => nodeKind(e.to.node));
    return { upstream: [...new Set(upstream)], downstream: [...new Set(downstream)] };
  }, [node, workflow]);

  if (!node) return null;
  const def = CAPSULES[node.kind];
  const isImageSource = node.kind === 'imageLoader' || node.kind === 'control' || node.kind === 'controlNetRack';
  const brokenImage = isImageSource && !String(node.params.image ?? '').trim();

  return (
    <div className="constellation-cmd" role="toolbar" aria-label={`Actions for ${def.title}`}>
      <span className="constellation-cmd-title" style={{ ['--node-accent' as string]: def.accent } as React.CSSProperties}>
        <span className="constellation-cmd-dot" aria-hidden="true" /> {def.title}
      </span>
      <div className="constellation-cmd-actions">
        <button className="btn tiny" type="button" title="Turn this prompt / model / sampler combo into a reusable recipe"
          onClick={() => { promoteToRecipe({ name: `From ${def.title}` }); setView('recipes'); }}>
          {Icon.beaker({ size: 12 })} Promote to recipe
        </button>
        <button className="btn tiny" type="button" title="Duplicate this node as a variant"
          onClick={() => { duplicateCapsule(node.id); setNote('Variant created'); }}>
          {Icon.copy({ size: 12 })} Create variant
        </button>
        <button className="btn tiny" type="button" title="Assemble a release pack for the active project"
          onClick={() => {
            if (activeProjectId) { const p = buildPack(activeProjectId); setNote(p ? `Release pack: ${p.summary.present}/${p.summary.total}` : null); }
            else setView('projects');
          }}>
          {Icon.download({ size: 12 })} Build release pack
        </button>
        <button className={`btn tiny ${showLineage ? 'on' : ''}`} type="button" title="Show what feeds into and out of this node"
          onClick={() => setShowLineage((v) => !v)}>
          {Icon.link({ size: 12 })} Lineage
        </button>
        {brokenImage ? (
          <button className="btn tiny" type="button" title="This node has no image — open Controls to fix it"
            onClick={() => setView('controls')}>
            {Icon.wrench({ size: 12 })} Repair asset
          </button>
        ) : null}
        <button className="btn tiny" type="button" title="Reveal missing related pieces for the active project"
          onClick={() => setView(brains.length ? 'projects' : 'mission')}>
          {Icon.target({ size: 12 })} Reveal missing
        </button>
        <button className="btn tiny danger" type="button" title="Archive (remove) this node"
          onClick={() => { removeCapsule(node.id); }}>
          {Icon.trash({ size: 12 })} Archive
        </button>
        <button className="constellation-cmd-close btn icon" type="button" aria-label="Deselect node" onClick={() => selectNode(null)}>
          {Icon.close({ size: 14 })}
        </button>
      </div>
      {note ? <span className="constellation-cmd-note">{Icon.ok({ size: 11 })} {note}</span> : null}
      {showLineage ? (
        <div className="constellation-lineage">
          <div><span className="lineage-label">Feeds from</span>{lineage.upstream.length ? lineage.upstream.map((u) => <span key={u} className="mini-tag">{u}</span>) : <span className="lineage-none">nothing</span>}</div>
          <div><span className="lineage-label">Feeds into</span>{lineage.downstream.length ? lineage.downstream.map((d) => <span key={d} className="mini-tag">{d}</span>) : <span className="lineage-none">nothing</span>}</div>
        </div>
      ) : null}
    </div>
  );
}
