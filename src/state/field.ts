/**
 * Persisted "Field" slice for the Render-Space Ghost Controller. Owns the slice
 * SHAPE + hydration so the store stays lean and OLD persisted state (which
 * predates this feature) loads gracefully — a missing slice seeds an empty one.
 *
 * Persisted: `ghosts` (their positions/intensity/pinned) + `anchors` (saved
 * sweet spots). The transient `recording` flag on a ghost is reset to false on
 * hydrate — a reload never resumes a mid-recording session.
 *
 * See docs/superpowers/specs/2026-07-06-render-space-ghost-controller-design.md.
 */
import type { MotionParamPatch } from '../core/motion/renderPlan';

/** A translucent controller orb flown through the render-space field. */
export interface Ghost {
  id: string;
  nodeId: string;
  /** Normalized field position; each axis in [0,1]. */
  pos: { x: number; y: number; z: number };
  /** [0,1] displacement scale from each bundle midpoint (a ghost-local control). */
  intensity: number;
  /** Pinned ghosts stay put on collapse-all / cleanup passes. */
  pinned: boolean;
  /** TRANSIENT: true only while actively recording a path (never persisted live). */
  recording: boolean;
}

/** A saved sweet spot: the ghost position + the exact param values there. */
export interface Anchor {
  id: string;
  nodeId: string;
  name: string;
  pos: { x: number; y: number; z: number };
  values: MotionParamPatch[];
}

/** Persisted field slice: live ghosts + saved anchors. */
export interface FieldState {
  ghosts: Ghost[];
  anchors: Anchor[];
}

/** A brand-new, empty field state. */
export function defaultFieldState(): FieldState {
  return { ghosts: [], anchors: [] };
}

function toPos(raw: unknown): { x: number; y: number; z: number } {
  const p = (raw ?? {}) as Partial<{ x: number; y: number; z: number }>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { x: n(p.x), y: n(p.y), z: n(p.z) };
}

function hydrateGhost(raw: unknown): Ghost | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<Ghost>;
  if (typeof g.id !== 'string' || typeof g.nodeId !== 'string') return null;
  return {
    id: g.id,
    nodeId: g.nodeId,
    pos: toPos(g.pos),
    intensity: typeof g.intensity === 'number' && Number.isFinite(g.intensity) ? g.intensity : 1,
    pinned: g.pinned === true,
    // Never resume a recording across a reload — always start settled.
    recording: false,
  };
}

function hydrateAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<Anchor>;
  if (typeof a.id !== 'string' || typeof a.nodeId !== 'string') return null;
  const values = Array.isArray(a.values)
    ? a.values.filter(
        (v): v is MotionParamPatch =>
          !!v && typeof v === 'object' &&
          typeof (v as MotionParamPatch).nodeId === 'string' &&
          typeof (v as MotionParamPatch).param === 'string' &&
          typeof (v as MotionParamPatch).value === 'number',
      )
    : [];
  return {
    id: a.id,
    nodeId: a.nodeId,
    name: typeof a.name === 'string' ? a.name : 'Anchor',
    pos: toPos(a.pos),
    values,
  };
}

/**
 * Additive hydration: a missing/invalid slice -> empty state; a present slice is
 * sanitized (drops malformed ghosts/anchors, resets the transient recording flag)
 * so old blobs and partially-written state always load without crashing.
 */
export function hydrateField(persisted: FieldState | undefined): FieldState {
  if (!persisted || typeof persisted !== 'object') return defaultFieldState();
  const ghosts = Array.isArray(persisted.ghosts)
    ? persisted.ghosts.map(hydrateGhost).filter((g): g is Ghost => g !== null)
    : [];
  const anchors = Array.isArray(persisted.anchors)
    ? persisted.anchors.map(hydrateAnchor).filter((a): a is Anchor => a !== null)
    : [];
  return { ghosts, anchors };
}
