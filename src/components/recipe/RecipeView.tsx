import type React from 'react';
import { CAPSULES } from '../../core/capsules';
import type { CapsuleKind } from '../../core/types';
import { findNode } from '../../core/workflow';
import { useStudio } from '../../state/store';
import { CapsuleIcon, Icon } from '../icons';
import { CapsuleParams } from '../inspector/CapsuleParams';
import { RecipeActions } from './RecipeActions';

/** Beginner-friendly ordering of the workflow as a top-to-bottom recipe. */
const RECIPE_ORDER: CapsuleKind[] = ['prompt', 'model', 'loraRack', 'control', 'canvas', 'sampler', 'export'];

export function RecipeView() {
  const workflow = useStudio((s) => s.workflow);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const selectNode = useStudio((s) => s.selectNode);

  return (
    <main className="recipe" aria-label="Recipe View">
      <div className="recipe-inner">
        <RecipeActions />
        <p className="recipe-intro">
          Fill in the capsules top to bottom, then press Render. Every field here edits the same workflow
          you can rewire in Graph View.
        </p>
        {RECIPE_ORDER.map((kind) => {
          const node = findNode(workflow, kind);
          if (!node) return null;
          const def = CAPSULES[kind];
          const selected = selectedNodeId === node.id;
          return (
            <section
              key={node.id}
              className={`card recipe-card ${selected ? 'selected' : ''}`}
              style={{ '--accent': def.accent } as React.CSSProperties}
              aria-label={def.title}
            >
              <div className="recipe-card-head">
                <span className="cap-icon"><CapsuleIcon kind={kind} /></span>
                <h2>{def.title}</h2>
                <span className="spacer" />
                <button
                  className="btn icon"
                  type="button"
                  aria-label={`Focus ${def.title} in inspector`}
                  aria-pressed={selected}
                  title="Focus in inspector"
                  onClick={() => selectNode(selected ? null : node.id)}
                >
                  {Icon.bolt({ size: 14 })}
                </button>
              </div>
              <p className="recipe-card-desc">{def.description}</p>
              {kind === 'loraRack' ? (
                <p className="field-help">Stack LoRAs in the rack on the right — they apply here.</p>
              ) : (
                <CapsuleParams nodeId={node.id} />
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
