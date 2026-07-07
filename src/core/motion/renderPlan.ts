/**
 * Render-plan stub — the honest seam into Phase 2 of the Living Constellation.
 *
 * `planMotionRender` is FULLY IMPLEMENTED + tested now (pure): it samples a clip
 * at evenly-spaced frame times and emits per-frame param patches. This proves the
 * data path end-to-end in tests without a fake render.
 *
 * `renderMotionClip` is a documented adapter seam that intentionally throws
 * `NotImplemented: Phase 2` — Phase 2 turns each frame's patches into a RenderJob
 * (reusing buildRenderJob + the AnimateDiff/batch path) and assembles the
 * sequence. Keeping it a loud throw preserves the "no silent fallbacks" invariant.
 */
import { sampleClip } from './interpolate';
import type { MotionClip } from './types';

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
 * Phase-2 bridge adapter. NOT wired to the render backend yet. Phase 2 will turn
 * the frames from `planMotionRender` into RenderJobs (buildRenderJob + the
 * AnimateDiff/batch path) and assemble the output sequence. Until then this
 * throws loudly so nothing pretends to render.
 *
 * @throws Error `NotImplemented: Phase 2`
 */
export function renderMotionClip(_clip: MotionClip, _opts?: PlanMotionRenderOptions): never {
  throw new Error('NotImplemented: Phase 2 — motion render is not wired to the bridge yet.');
}
