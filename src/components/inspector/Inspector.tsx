import type React from 'react';
import { CAPSULES } from '../../core/capsules';
import { useStudio } from '../../state/store';
import { CapsuleIcon } from '../icons';
import { CapsuleParams } from './CapsuleParams';

/**
 * Edits the currently-selected capsule's parameters. Shared by Recipe View and
 * Graph View — both select nodes into the same `selectedNodeId`, so a capsule is
 * always edited through this one inspector.
 */
export function Inspector() {
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const node = useStudio((s) => s.workflow.nodes.find((n) => n.id === selectedNodeId));

  if (!node) {
    return <p className="inspector-empty">Select a capsule in the Recipe or Graph to edit it here.</p>;
  }

  const def = CAPSULES[node.kind];
  return (
    <div style={{ '--accent': def.accent } as React.CSSProperties}>
      <div className="inspector-head">
        <span className="cap-icon"><CapsuleIcon kind={node.kind} /></span>
        <h4>{def.title}</h4>
      </div>
      <p className="inspector-desc">{def.description}</p>
      <CapsuleParams nodeId={node.id} />
    </div>
  );
}
