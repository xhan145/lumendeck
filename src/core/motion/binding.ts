/**
 * Parameter-binding model for the Motion Engine. A motion track may legally bind
 * only to a NUMERIC ParamDef of the node's capsule (kind === 'number'). These
 * pure helpers validate binds, list bindable params, and suggest a sensible
 * default track per node. No DOM — unit-testable.
 */
import { CAPSULES } from '../capsules';
import type { CapsuleKind } from '../types';
import { primaryWeight } from '../../components/graph/graph3d/orbWeight';

/**
 * True iff `param` names a ParamDef on `kind`'s capsule whose kind is 'number'.
 * `seed` params (kind 'seed'), toggles, selects, text, etc. are NOT bindable.
 * Unknown kind or unknown param -> false.
 */
export function isBindable(kind: CapsuleKind, param: string): boolean {
  const def = CAPSULES[kind];
  if (!def) return false;
  const p = def.params.find((pd) => pd.id === param);
  return !!p && p.kind === 'number';
}

/** The ids of every numeric ('number') ParamDef on `kind`'s capsule, in order. */
export function bindableParams(kind: CapsuleKind): string[] {
  const def = CAPSULES[kind];
  if (!def) return [];
  return def.params.filter((p) => p.kind === 'number').map((p) => p.id);
}

/**
 * Suggest a default param to bind a track to for a node of `kind`, reusing the
 * v0.13 primary-weight table where it points at a bindable numeric param (e.g.
 * sampler -> cfg). Falls back to the first bindable param, or null when the kind
 * has no numeric params (a weightless capsule).
 *
 * `params` supplies live values so `primaryWeight` can resolve rack means etc.;
 * only its `label`/derivation is used to locate the source param here, so an
 * empty object is acceptable for a by-kind suggestion.
 */
export function defaultTrackParam(kind: CapsuleKind, params: Record<string, unknown> = {}): string | null {
  const pw = primaryWeight(kind, params);
  if (pw) {
    // primaryWeight is derived from a specific ParamDef; if that param is a
    // bindable number, prefer it. Match by the ParamDef whose label equals the
    // primary-weight label (rack means use a synthetic label -> no direct match,
    // so we correctly fall through to the first bindable param below).
    const match = CAPSULES[kind].params.find((p) => p.label === pw.label && p.kind === 'number');
    if (match) return match.id;
  }
  const bindable = bindableParams(kind);
  return bindable.length > 0 ? bindable[0] : null;
}
