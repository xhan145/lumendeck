/**
 * Render-plan core — the honest data path into Phase 2 of the Living Constellation.
 *
 * `planMotionRender` is FULLY IMPLEMENTED + tested (pure): it samples a clip at
 * evenly-spaced frame times and emits per-frame param patches. `applyPatches` and
 * `buildMotionRenderJobs` turn that plan into concrete per-frame RenderJobs by
 * cloning the workflow, setting each patch's `nodeId.param`, and running the
 * EXISTING `buildRenderJob`. Everything here is pure (no fetch) so the whole plan
 * is unit-tested without a backend; the bridge boundary lives in the adapters.
 */
import { sampleClip } from './interpolate';
import type { MotionClip } from './types';
import type { Workflow } from '../types';
import { updateNodeParam } from '../workflow';
import { buildRenderJob, type RenderJob } from '../../bridge/adapter';
import type { WildcardSet } from '../prompt/wildcards';

/** One patch: set `param` on `nodeId` to `value` for this frame. */
export interface MotionParamPatch {
  nodeId: string;
  param: string;
  value: number;
}

/** One rendered frame's plan: the frame index, its clip time, and its patches. */
export interface MotionRenderFrame {
  frame: number;
  /** clip time in seconds this frame samples at */
  t: number;
  paramPatches: MotionParamPatch[];
}

export interface PlanMotionRenderOptions {
  /** number of frames to sample; clamped to >= 1 */
  frames: number;
}

/**
 * Plan a motion render: sample `clip` at `frames` evenly-spaced times across
 * [0, duration] and emit per-frame param patches from the clip's tracks.
 *
 * Spacing: with N frames, frame i samples at t = duration · i / (N - 1) so the
 * first frame is at 0 and the last is exactly at `duration` (single frame -> 0).
 * Pure and deterministic. Mirrors the style of prompt/variations.planVariations.
 */
export function planMotionRender(clip: MotionClip, opts: PlanMotionRenderOptions): MotionRenderFrame[] {
  const frames = Math.max(1, Math.floor(opts.frames));
  const out: MotionRenderFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const t = frames <= 1 ? 0 : (clip.duration * i) / (frames - 1);
    const sampled = sampleClip(clip, t);
    const paramPatches: MotionParamPatch[] = [];
    for (const track of clip.tracks) {
      const key = `${track.nodeId}:${track.param}`;
      const value = sampled.get(key);
      if (value != null) paramPatches.push({ nodeId: track.nodeId, param: track.param, value });
    }
    out.push({ frame: i, t, paramPatches });
  }
  return out;
}

/**
 * Apply a frame's param patches to a workflow, returning a NEW workflow with each
 * `nodeId.param` set to its patched value and everything else untouched. Pure:
 * `updateNodeParam` clones the affected node (and bumps `version`); nodes/edges
 * not named by a patch are shared by reference. Patches naming a missing node are
 * simply no-ops (updateNodeParam leaves the list unchanged), so a stale clip
 * never corrupts the graph.
 */
export function applyPatches(workflow: Workflow, patches: MotionParamPatch[]): Workflow {
  let next = workflow;
  for (const patch of patches) {
    next = updateNodeParam(next, patch.nodeId, patch.param, patch.value);
  }
  return next;
}

/** The per-frame jobs plus the clip times they sample at (indices align 1:1). */
export interface MotionRenderJobs {
  jobs: RenderJob[];
  frameTimes: number[];
}

/**
 * Build one RenderJob per motion frame: plan the clip, apply each frame's patches
 * to a cloned workflow, and run the EXISTING `buildRenderJob` so every job carries
 * the same shape as a single-image render (ControlNet/img2img/hires/wildcards all
 * honored per-frame at that frame's animated values). Pure — no bridge/fetch.
 *
 * `frameTimes[i]` is the clip time (seconds) job `jobs[i]` was sampled at.
 */
export function buildMotionRenderJobs(
  workflow: Workflow,
  clip: MotionClip,
  opts: PlanMotionRenderOptions,
  wildcardSets: WildcardSet[] = [],
): MotionRenderJobs {
  const frames = planMotionRender(clip, opts);
  const jobs: RenderJob[] = [];
  const frameTimes: number[] = [];
  for (const frame of frames) {
    const patched = applyPatches(workflow, frame.paramPatches);
    jobs.push(buildRenderJob(patched, wildcardSets));
    frameTimes.push(frame.t);
  }
  return { jobs, frameTimes };
}
