/**
 * Open Constellation — domain types. PURE: no DOM, no three.js.
 *
 * A ConstellationNode is one body in the explorable capability universe: the
 * selected node renders as the central planet, its children as orbiting
 * satellites, their children as subordinate moons. The renderer supports
 * arbitrary depth and never hard-codes node ids.
 */

export type ConstellationNodeType =
  | 'core'
  | 'mission'
  | 'addon'
  | 'tool'
  | 'integration'
  | 'evidence';

export type ConstellationNodeStatus = 'active' | 'forming' | 'dormant' | 'complete';

export interface ConstellationNode {
  /** Stable unique id (used for lookup, history, and deterministic orbits). */
  id: string;
  /** Short display name. */
  label: string;
  /** One-to-two sentence description shown in the overlay. */
  description?: string;
  /** [primary, secondary] concrete colors driving the body's shader. */
  colors: [string, string];
  type?: ConstellationNodeType;
  status?: ConstellationNodeStatus;
  /** 0..1 relative importance — scales body size and shader energy. */
  strength?: number;
  children?: ConstellationNode[];
}

/** Props boundary for the scene — domain data in, selection events out. */
export interface ConstellationSceneProps {
  root: ConstellationNode;
  initialNodeId?: string;
  onNodeSelect?: (node: ConstellationNode) => void;
  className?: string;
}
