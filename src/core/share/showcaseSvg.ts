import type { Workflow } from '../types';
import { escapeHtml } from './showcase';

/**
 * Pure, DOM-free renderer: turns a workflow graph into a standalone inline
 * `<svg>` string for the shareable Showcase (and reusable by the app). On-brand
 * gradient orbs at each node's 2D position, thin wires per edge. Deterministic;
 * no `<script>`, no external references. Returns '' when the graph has no nodes.
 */

const BRAND = {
  cyan: '#34D6F4',
  violet: '#7C3AED',
  mango: '#F5A623',
} as const;
type BrandKey = keyof typeof BRAND;

// Node kind -> orb color family (mirrors the app's orb ramp intent). Keyed by
// the kind string so it is robust to the exact CapsuleKind union: text/
// conditioning = cyan, models/loras/control = violet, latent/image = mango.
// Unknown kinds fall back to cyan so a new capsule never renders colorless.
const KIND_COLOR: Record<string, BrandKey> = {
  prompt: 'cyan',
  clipTextEncode: 'cyan',
  clipSetLastLayer: 'cyan',
  conditioningCombine: 'cyan',
  conditioningAverage: 'cyan',
  conditioningSetArea: 'cyan',
  model: 'violet',
  checkpointLoader: 'violet',
  vaeLoader: 'violet',
  loraLoader: 'violet',
  loraRack: 'violet',
  control: 'violet',
  controlNetLoader: 'violet',
  controlNetApply: 'violet',
  controlNetRack: 'violet',
  cannyPreprocessor: 'violet',
  depthPreprocessor: 'violet',
  posePreprocessor: 'violet',
  emptyLatent: 'mango',
  latentNoise: 'mango',
  latentUpscale: 'mango',
  latentCrop: 'mango',
  latentComposite: 'mango',
  vaeEncode: 'mango',
  vaeDecode: 'mango',
  imageLoader: 'mango',
};

function colorFor(kind: string): BrandKey {
  return KIND_COLOR[kind] ?? 'cyan';
}

/** Coerce a (possibly hostile, e.g. from a crafted .lumen) coordinate to a finite
 * number. A non-numeric value becomes 0 — this is what blocks SVG-attribute
 * injection: the coordinate can never carry markup into the output. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const R = 26; // orb radius
const PAD = 60; // viewBox padding around the node bounds

export function renderConstellationSvg(
  graph: Workflow,
  opts: { width?: number } = {},
): string {
  const rawNodes = graph.nodes ?? [];
  if (rawNodes.length === 0) return '';

  // Normalize coordinates to finite numbers ONCE, up front, so no raw (possibly
  // string/injected) coordinate ever reaches an SVG attribute.
  const nodes = rawNodes.map((n) => ({ id: n.id, kind: n.kind, x: num(n.x), y: num(n.y) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const maxY = Math.max(...nodes.map((n) => n.y));
  const vbX = minX - PAD;
  const vbY = minY - PAD;
  const vbW = maxX - minX + PAD * 2;
  const vbH = maxY - minY + PAD * 2;

  // One gradient per brand color, referenced by the orbs.
  const defs = (Object.keys(BRAND) as BrandKey[])
    .map(
      (k) =>
        `<radialGradient id="orb-${k}" cx="38%" cy="34%" r="72%">` +
        `<stop offset="0%" stop-color="${BRAND[k]}" stop-opacity="1"/>` +
        `<stop offset="70%" stop-color="${BRAND[k]}" stop-opacity="0.72"/>` +
        `<stop offset="100%" stop-color="${BRAND[k]}" stop-opacity="0.28"/>` +
        `</radialGradient>`,
    )
    .join('');

  // Wires first (behind orbs). Skip any edge with a missing endpoint.
  const wires = (graph.edges ?? [])
    .map((e) => {
      const a = byId.get(e.from.node);
      const b = byId.get(e.to.node);
      if (!a || !b) return '';
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${BRAND.cyan}" stroke-opacity="0.35" stroke-width="2"/>`;
    })
    .filter(Boolean)
    .join('');

  const orbs = nodes
    .map((n) => {
      const c = colorFor(n.kind);
      return (
        `<g>` +
        `<circle cx="${n.x}" cy="${n.y}" r="${R}" fill="url(#orb-${c})" stroke="${BRAND[c]}" stroke-opacity="0.55" stroke-width="1.5"/>` +
        `<text x="${n.x}" y="${n.y + R + 20}" text-anchor="middle" font-size="18" fill="#C9E9F5" font-family="system-ui, sans-serif">${escapeHtml(String(n.kind))}</text>` +
        `</g>`
      );
    })
    .join('');

  const widthAttr = opts.width ? ` width="${opts.width}"` : '';
  return (
    `<svg viewBox="${vbX} ${vbY} ${vbW} ${vbH}"${widthAttr} preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Node constellation">` +
    `<defs>${defs}</defs>` +
    wires +
    orbs +
    `</svg>`
  );
}
