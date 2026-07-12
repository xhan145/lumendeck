/**
 * Data→visual encoding registry for the 3D constellation. PURE, unit-tested.
 *
 * Hard rule (redteam spec, "Data Encoding Rules"): no visual layer may render
 * without a registry entry naming the exact product datum it encodes. SEEDED in
 * the First Slice with the single mass→fabric-well entry and grown in later
 * phases. A unit test walks the active layer list against this registry so an
 * unregistered effect fails CI.
 */

/** A rendered visual layer that must justify itself with a data source. */
export type EncodingLayer = 'fabric' | 'anomaly' | 'luminosity' | 'particles' | 'energyFlow' | 'environment' | 'mist';

export interface EncodingEntry {
  /** Stable id (also the human-facing name in the legend). */
  id: string;
  /** Exact product datum this encoding reads, as an auditable string. */
  datum: string;
  /** The visual channel it drives. */
  channel: string;
  /** The render layer that owns the channel. */
  layer: EncodingLayer;
  /** Always on (vs behind a toggle/tooltip). */
  alwaysOn: boolean;
}

/** The registry. Every shipped visual layer MUST appear here. */
export const ENCODINGS: readonly EncodingEntry[] = [
  {
    id: 'mass',
    datum: 'weightT(primaryWeight(kind, params))',
    channel: 'fabric well depth + sigma',
    layer: 'fabric',
    alwaysOn: true,
  },
  {
    id: 'anomaly',
    datum: 'health: HealthIssue[] attributed by nodeId (core/health.ts)',
    channel: 'palette-breaking orb outline ring (red error / amber warning)',
    layer: 'anomaly',
    alwaysOn: true,
  },
  {
    id: 'luminosity',
    datum: 'nodeMeta.lastActiveAt (create/param-edit recency, state/nodeMeta.ts)',
    channel: 'orb emissive glow (half-life decay)',
    layer: 'luminosity',
    alwaysOn: true,
  },
  {
    id: 'gravity-dust',
    datum: 'packWells(nodes) mass field (the same wells that deform the fabric)',
    channel: 'volumetric particle flow: infall direction, orbital streams, funnel plunge depth',
    layer: 'particles',
    alwaysOn: false, // standard tier and up; reduced motion disables
  },
  {
    id: 'dust-energy',
    datum: 'per-particle energy (gravity pull + |v| from the integration)',
    channel: 'particle color cool→warm, brightness, sprite size, twinkle',
    layer: 'particles',
    alwaysOn: false, // standard tier and up; reduced motion disables
  },
  {
    id: 'workflow-energy',
    datum: 'workflow.edges topology + nodeMeta endpoint activity + health errors',
    channel: 'directed pulses along wires: count/speed/brightness by activity; crawl+dim on error',
    layer: 'energyFlow',
    alwaysOn: false, // standard tier and up; reduced motion disables
  },
  {
    id: 'environment',
    datum: 'none — static parallax depth reference (starfield + cinematic backdrop); non-signaling by design',
    channel: 'background only; carries no product state and never animates',
    layer: 'environment',
    alwaysOn: false, // rich tier and up
  },
  {
    id: 'mist-steam',
    datum: 'nodeMeta.lastActiveAt (activity recency, state/nodeMeta.ts — same datum as luminosity)',
    channel: 'curl-noise smoke emission around the orb: freshly-touched nodes visibly steam, 45s half-life',
    layer: 'mist',
    alwaysOn: false, // standard tier and up; reduced motion disables (the glow carries the datum statically)
  },
];

/** All layers named by at least one registry entry. */
export function registeredLayers(): Set<EncodingLayer> {
  return new Set(ENCODINGS.map((e) => e.layer));
}

/**
 * Active render layers with no backing registry entry (empty = compliant).
 * Tests assert this stays empty for the layers the view actually renders.
 */
export function unregisteredLayers(activeLayers: readonly EncodingLayer[]): EncodingLayer[] {
  const known = registeredLayers();
  return activeLayers.filter((l) => !known.has(l));
}
