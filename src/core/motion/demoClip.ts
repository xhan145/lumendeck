/**
 * Demo constellation clip. On first run (no persisted motion) we seed ONE clip
 * so pressing Play immediately choreographs the orbs and sweeps a value: a 3s
 * loop with a track animating the Sampler `cfg` 4 -> 18 -> 7 (easeInOut) and an
 * orbit OrbMotion on a couple of nodes.
 *
 * The demo is resolved against a concrete Workflow so its track/orbMotions point
 * at real node ids (the sampler id is not fixed across sessions). Seeding is
 * idempotent — see `seedDemoClip`.
 */
import { findNode } from '../workflow';
import type { Workflow } from '../types';
import type { MotionClip, MotionState, OrbMotion } from './types';

/** Stable id so re-seeding is idempotent (seedDemoClip checks for it). */
export const DEMO_CLIP_ID = 'motion_demo_constellation';

const ORBIT: OrbMotion = { style: 'orbit', speed: 1.2, amplitude: 60 };

/**
 * Build the demo clip for a given workflow. The value track targets the sampler's
 * `cfg`; orbit motion is applied to the sampler plus one or two other core nodes
 * (prompt/model) when present. Returns null when there is no sampler to animate.
 */
export function buildDemoClip(workflow: Workflow): MotionClip | null {
  const sampler = findNode(workflow, 'sampler');
  if (!sampler) return null;

  const orbMotions: Record<string, OrbMotion> = { [sampler.id]: { ...ORBIT } };
  const model = findNode(workflow, 'model');
  const prompt = findNode(workflow, 'prompt');
  if (model) orbMotions[model.id] = { style: 'orbit', speed: 0.9, amplitude: 48 };
  if (prompt) orbMotions[prompt.id] = { style: 'bob', speed: 1.6, amplitude: 24 };

  return {
    id: DEMO_CLIP_ID,
    name: 'Demo constellation',
    duration: 3,
    fps: 24,
    loop: true,
    tracks: [
      {
        id: 'motion_demo_cfg',
        nodeId: sampler.id,
        param: 'cfg',
        // Stable, content-derived keyframe ids (not random) so re-seeding the
        // demo is byte-idempotent and tests never see a nondeterministic id.
        keyframes: [
          { id: 'motion_demo_cfg_k0', t: 0, value: 4, easing: 'easeInOut' },
          { id: 'motion_demo_cfg_k1', t: 1.5, value: 18, easing: 'easeInOut' },
          { id: 'motion_demo_cfg_k2', t: 3, value: 7, easing: 'easeInOut' },
        ],
      },
    ],
    orbMotions,
  };
}

/**
 * Idempotently seed the demo clip into a MotionState for `workflow`. If the demo
 * clip id is already present the state is returned unchanged. When seeding a
 * previously-empty state the demo becomes the active clip.
 */
export function seedDemoClip(state: MotionState, workflow: Workflow): MotionState {
  if (state.clips.some((c) => c.id === DEMO_CLIP_ID)) return state;
  const demo = buildDemoClip(workflow);
  if (!demo) return state;
  return {
    clips: [...state.clips, demo],
    activeClipId: state.activeClipId ?? demo.id,
  };
}
