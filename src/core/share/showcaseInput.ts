import { buildLumenFile } from '../lumenFile';
import type { ExportManifest } from '../manifest';
import type { RackPreset } from '../types';
import { renderConstellationSvg } from './showcaseSvg';
import type { ShowcaseInput, ShowcaseProvenance } from './showcase';

/**
 * Pure builders that turn gallery renders (+ their `ExportManifest`) into a
 * `ShowcaseInput`. Shared by the Gallery drawer and the Creative-OS Projects
 * view so both share one mapping (DRY). DOM-free and unit-testable.
 */

export interface RenderSource {
  dataUrl: string;
  mediaType: 'image' | 'video';
  manifest: ExportManifest;
  caption?: string;
}

/** UTF-8-safe base64 (handles emoji/accents in prompts; works in Node + browser). */
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function slugish(text: string, fallback = 'project'): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

function provenanceOf(m: ExportManifest): ShowcaseProvenance {
  const params: { label: string; value: string }[] = [
    { label: 'Sampler', value: `${m.sampler.name} · ${m.sampler.steps} steps · cfg ${m.sampler.cfg}` },
    { label: 'Canvas', value: `${m.canvas.width}×${m.canvas.height}` },
  ];
  if (m.loras.length) {
    params.push({ label: 'LoRAs', value: m.loras.map((l) => `${l.name} @ ${l.weight}`).join(', ') });
  }
  if (m.controlNets.length) {
    params.push({ label: 'ControlNet', value: m.controlNets.map((c) => `${c.type} @ ${c.strength}`).join(', ') });
  }
  return {
    prompt: m.prompt,
    negativePrompt: m.negativePrompt || undefined,
    model: m.model?.name,
    seed: m.seed,
    params,
  };
}

/**
 * Build a showcase input from one or more renders. Provenance, the embedded
 * `.lumen`, and the constellation SVG are taken from the FIRST source's
 * manifest (the "primary" render). The `.lumen` embed is present whenever that
 * manifest carries a non-empty workflow graph (the normal case); a legacy
 * manifest with an empty graph yields a provenance-only showcase.
 */
export function showcaseInputFromRenders(
  title: string,
  sources: RenderSource[],
  rackPresets: RackPreset[],
  now: Date,
): ShowcaseInput {
  if (sources.length === 0) throw new Error('Cannot build a showcase with no renders.');
  const primary = sources[0];
  const graph = primary.manifest.graph;
  const hasGraph = Boolean(graph && Array.isArray(graph.nodes) && graph.nodes.length > 0);

  const lumen = hasGraph
    ? {
        base64: utf8ToBase64(JSON.stringify(buildLumenFile(graph, rackPresets, now))),
        filename: `${slugish(title)}.lumen`,
      }
    : undefined;

  return {
    title,
    items: sources.map((s) => ({ dataUrl: s.dataUrl, mediaType: s.mediaType, caption: s.caption })),
    provenance: provenanceOf(primary.manifest),
    lumen,
    constellationSvg: hasGraph ? renderConstellationSvg(graph) : undefined,
  };
}
