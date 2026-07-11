import type { ConstellationNode } from './types';

/**
 * Selection + navigation-history logic for the Open Constellation. PURE and
 * reducer-shaped: no DOM, no three.js, fully unit-testable.
 *
 * History semantics: selecting a satellite pushes the previous center onto the
 * history stack; Back pops one level. Selecting the current node is a no-op
 * (never duplicates); Back at the root is a safe no-op. Nodes are resolved
 * through a normalized map, never by assuming direct-child relationships.
 */

export interface SelectionState {
  currentId: string;
  /** Previously-centered node ids, oldest first. Empty at the root. */
  history: string[];
}

/** Flatten the tree into id → node. Later duplicate ids are ignored (first wins). */
export function indexConstellation(root: ConstellationNode): Map<string, ConstellationNode> {
  const map = new Map<string, ConstellationNode>();
  const walk = (node: ConstellationNode) => {
    if (!map.has(node.id)) map.set(node.id, node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return map;
}

/** id → parent id for every node under root (root itself has no entry). */
export function indexParents(root: ConstellationNode): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: ConstellationNode) => {
    for (const child of node.children ?? []) {
      if (!map.has(child.id)) map.set(child.id, node.id);
      walk(child);
    }
  };
  walk(root);
  return map;
}

/** Recursive lookup without a prebuilt index (convenience for callers/tests). */
export function findNode(root: ConstellationNode, id: string): ConstellationNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function initialSelection(rootId: string): SelectionState {
  return { currentId: rootId, history: [] };
}

/**
 * Promote `id` to the center. No-op (same reference) when `id` is already
 * current or unknown to the index — an invalid click can never corrupt state.
 */
export function selectNode(
  state: SelectionState,
  id: string,
  index: Map<string, ConstellationNode>,
): SelectionState {
  if (id === state.currentId || !index.has(id)) return state;
  return { currentId: id, history: [...state.history, state.currentId] };
}

/**
 * Pop one level. Safe no-op (same reference) when history is empty (at root).
 * With an `index`, ghost entries — ids that vanished in a live tree rebuild
 * (deleted collection, concept leaves replaced by real projects) — are skipped
 * so Back always lands on a node that still exists.
 */
export function goBack(state: SelectionState, index?: Map<string, ConstellationNode>): SelectionState {
  let history = state.history;
  while (history.length > 0) {
    const targetId = history[history.length - 1];
    history = history.slice(0, -1);
    if (!index || index.has(targetId)) return { currentId: targetId, history };
  }
  return state; // nothing valid to return to
}

export function canGoBack(state: SelectionState): boolean {
  return state.history.length > 0;
}
