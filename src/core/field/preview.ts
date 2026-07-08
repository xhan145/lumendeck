/**
 * Streaming-preview job builder — turns the active preset's field-resolved params
 * into a FAST, low-res RenderJob so dragging a ghost through the field renders a
 * sub-second miniature of "where dropping the orb here would land". Pure — no
 * fetch; the bridge boundary stays in the adapters. See the field-presets
 * streaming-preview spec §"Live streaming preview".
 */
import type { Workflow, CapsuleKind } from '../types';
import { findNode, updateNodeParam } from '../workflow';
import { buildRenderJob, type RenderJob } from '../../bridge/adapter';
import type { PresetPatch } from './presets';
import type { WildcardSet } from '../prompt/wildcards';

export interface PreviewJobOptions {
  /** Square canvas edge in px for the fast preview (default 320). */
  size?: number;
  /** Sampler steps for the fast preview (default 4 — turbo-friendly). */
  steps?: number;
  /** Wildcard sets, forwarded to buildRenderJob (defaults to none). */
  wildcardSets?: WildcardSet[];
}

/**
 * Build a low-res preview job from a base workflow + the preset patches for the
 * current field position. Each patch's node KIND is resolved to the concrete node
 * (patches naming a kind absent from the graph are skipped — honest: that axis has
 * nothing to drive here), applied via `updateNodeParam`, then run through the
 * EXISTING `buildRenderJob` so the preview is a faithful miniature (same
 * ControlNet/img2img/LoRA plumbing). The result overrides width/height=`size` and
 * steps=`steps`, and forces an IMAGE output (never a video encode) so the preview
 * stays fast even when the Video node is enabled.
 */
export function buildPreviewJob(
  workflow: Workflow,
  patches: PresetPatch[],
  opts: PreviewJobOptions = {},
): RenderJob {
  const size = Math.max(64, Math.floor(opts.size ?? 320));
  const steps = Math.max(1, Math.floor(opts.steps ?? 4));

  let patched = workflow;
  for (const p of patches) {
    const node = findNode(patched, p.node as CapsuleKind);
    if (node) patched = updateNodeParam(patched, node.id, p.param, p.value);
  }

  const job = buildRenderJob(patched, opts.wildcardSets ?? []);
  return {
    ...job,
    width: size,
    height: size,
    steps,
    output: 'image',
    frameCount: 1,
    // A forced image never encodes a clip, so a video format would be misleading.
    format: job.output === 'video' ? 'png' : job.format,
  };
}
