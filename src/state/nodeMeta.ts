/**
 * Per-node activity metadata for the constellation's LUMINOSITY encoding: an orb
 * glows by how recently its node was touched — created or param-edited. PURE +
 * unit-tested; the store owns the map and stamps Date.now() on real activity.
 *
 * Honest datum: this is EDIT/CREATE recency (the node you're actively working
 * on), NOT render attribution — a render is workflow-wide, not per-node, so we
 * don't pretend one node "rendered".
 */

export interface NodeMeta {
  /** ms epoch when the node first appeared. */
  createdAt: number;
  /** ms epoch of the node's most recent activity (create or param edit). */
  lastActiveAt: number;
}

export type NodeMetaMap = Record<string, NodeMeta>;

/** Half-life (ms) of the activity glow — a touched node fades to half over this. */
export const LUMINOSITY_HALF_LIFE_MS = 45_000;

/** Record activity for a node at `now` (creates the entry on first touch). */
export function touchNode(map: NodeMetaMap, nodeId: string, now: number): NodeMetaMap {
  const prev = map[nodeId];
  return { ...map, [nodeId]: { createdAt: prev?.createdAt ?? now, lastActiveAt: now } };
}

/**
 * Ensure every current node id has an entry. Seeded nodes are COLD
 * (lastActiveAt = 0) so pre-existing / loaded / migrated nodes do NOT glow — only
 * nodes genuinely touched this session light up. Returns the same reference when
 * nothing was missing.
 */
export function seedNodeMeta(map: NodeMetaMap, nodeIds: readonly string[], now: number): NodeMetaMap {
  let out = map;
  for (const id of nodeIds) {
    if (!out[id]) {
      if (out === map) out = { ...map };
      out[id] = { createdAt: now, lastActiveAt: 0 };
    }
  }
  return out;
}

/** Keep only entries whose id is in `nodeIds` (bounds persisted size — drops orphans). */
export function pruneNodeMeta(map: NodeMetaMap, nodeIds: readonly string[]): NodeMetaMap {
  const keep = new Set(nodeIds);
  const out: NodeMetaMap = {};
  let dropped = false;
  for (const [id, meta] of Object.entries(map)) {
    if (keep.has(id)) out[id] = meta;
    else dropped = true;
  }
  return dropped ? out : map;
}

/** Activity glow in 0..1 at `now` (exponential half-life decay); 0 for unknown nodes. */
export function emissiveFor(meta: NodeMeta | undefined, now: number, halfLifeMs = LUMINOSITY_HALF_LIFE_MS): number {
  if (!meta) return 0;
  const age = now - meta.lastActiveAt;
  if (age <= 0) return 1;
  return Math.pow(0.5, age / halfLifeMs);
}

/** Validate/repair a persisted node-meta blob (drops malformed entries). */
export function hydrateNodeMeta(raw: unknown): NodeMetaMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: NodeMetaMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const rec = v as Record<string, unknown>;
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : null;
    const lastActiveRaw = typeof rec.lastActiveAt === 'number' && Number.isFinite(rec.lastActiveAt) ? rec.lastActiveAt : createdAt;
    if (createdAt == null || lastActiveRaw == null) continue;
    out[id] = { createdAt, lastActiveAt: lastActiveRaw };
  }
  return out;
}
