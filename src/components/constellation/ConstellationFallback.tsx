import type { ConstellationNode } from './types';

/**
 * Clean hierarchical HTML rendering of the constellation — the guaranteed
 * non-canvas path to every node name, description, and relationship. Serves
 * three duties: WebGL-unavailable fallback, an accessible alternative for
 * screen readers and keyboard users, and a "view as list" mode anyone can
 * prefer. Selecting a node here drives the same selection state as the scene.
 */

export interface ConstellationFallbackProps {
  root: ConstellationNode;
  currentId: string;
  onSelect: (id: string) => void;
  /** Why the list is showing (fallback vs chosen) — read by screen readers. */
  reason?: string;
}

function TreeNode({ node, currentId, onSelect }: { node: ConstellationNode; currentId: string; onSelect: (id: string) => void }) {
  const current = node.id === currentId;
  return (
    <li>
      <span className="constellation-tree-node">
        <span className="constellation-tree-dot" style={{ background: node.colors[0] }} aria-hidden="true" />
        <button
          type="button"
          className="constellation-tree-select"
          aria-current={current ? 'true' : undefined}
          onClick={() => onSelect(node.id)}
        >
          <b>{node.label}</b>
        </button>
        {node.description ? <small>{node.description}</small> : null}
      </span>
      {node.children && node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} currentId={currentId} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ConstellationFallback({ root, currentId, onSelect, reason }: ConstellationFallbackProps) {
  return (
    <div className="constellation-fallback">
      <p className="constellation-fallback-note">
        {reason ?? 'Every branch, as a list. The same constellation — no canvas required.'}
      </p>
      <ul className="constellation-tree" aria-label="LumenDeck capability constellation">
        <TreeNode node={root} currentId={currentId} onSelect={onSelect} />
      </ul>
    </div>
  );
}
