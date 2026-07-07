/**
 * Audio Reactivity (Phase 3) — pure band -> per-orb reaction mapping.
 *
 * HONEST FRAMING: a deterministic, curated translation of frequency bands into
 * transient orb reactions (spatial offset + scale + ring value). It does NOT
 * write workflow params — the reactive tick applies these as a live PREVIEW
 * overlay (exactly like motion playback), and only an explicit "bake" persists a
 * capture. Pure + unit-tested. See
 * docs/superpowers/specs/2026-07-06-audio-reactivity-phase3-design.md.
 */
import type { Workflow } from '../types';
import type { Bands } from './bands';

/** Which band a target reacts to. */
export type AudioBand = 'bass' | 'mid' | 'treble' | 'level';

/**
 * What a target drives on its orb:
 *   x/y/z  -> a world-space position offset (like motion playback offsets)
 *   scale  -> a multiplicative size pulse
 *   ring   -> the orb's equatorial value ring (0..1 sweep / tint)
 */
export type AudioTargetKind = 'x' | 'y' | 'z' | 'ring' | 'scale';

/** One band -> orb-channel wiring with a gain multiplier. */
export interface AudioTarget {
  band: AudioBand;
  kind: AudioTargetKind;
  nodeId: string;
  /** multiplies the band's 0..1 energy before it drives the channel */
  gain: number;
}

/** The full, editable mapping: a flat list of band -> orb-channel targets. */
export interface AudioMapping {
  targets: AudioTarget[];
}

/** A transient per-orb spatial reaction (mirrors motion's MotionOffset shape). */
export interface AudioOffset {
  dx: number;
  dy: number;
  dz: number;
  /** multiplicative scale (1 = unchanged) */
  scale: number;
}

/** The full reaction for one analysis frame: offsets + ring values, by nodeId. */
export interface AudioReaction {
  offsets: Map<string, AudioOffset>;
  ringValues: Map<string, number>;
}

/** World units a full-strength (value 1) axis band displaces an orb. */
export const AUDIO_AXIS_UNIT = 90;
/** Extra scale a full-strength (value 1) 'scale' band adds (1 -> 1 + this). */
export const AUDIO_SCALE_UNIT = 0.7;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The 0..1 energy a target reads from a bands frame (before its gain). */
export function bandEnergy(bands: Bands, band: AudioBand): number {
  return bands[band];
}

/**
 * Translate one bands frame into per-orb offsets + ring values through `mapping`.
 *
 * For each target, `raw = bands[band] * gain`, then:
 *   - x/y/z -> add `raw * AUDIO_AXIS_UNIT` to that node's offset (world units)
 *   - scale -> add `raw * AUDIO_SCALE_UNIT` on top of the identity scale 1
 *   - ring  -> accumulate into the node's ring value, clamped to 0..1
 * A node that receives ANY spatial target gets an offset entry seeded at the
 * identity ({0,0,0, scale:1}); nodes with only a ring target get a ring value
 * but no offset. `base` (optional) is a prior reaction to accumulate ONTO (its
 * maps are cloned, never mutated). Pure + deterministic.
 */
export function applyAudio(bands: Bands, mapping: AudioMapping, base?: AudioReaction): AudioReaction {
  const offsets = new Map<string, AudioOffset>();
  const ringValues = new Map<string, number>();
  if (base) {
    for (const [id, o] of base.offsets) offsets.set(id, { ...o });
    for (const [id, v] of base.ringValues) ringValues.set(id, v);
  }
  const ensure = (id: string): AudioOffset => {
    let o = offsets.get(id);
    if (!o) {
      o = { dx: 0, dy: 0, dz: 0, scale: 1 };
      offsets.set(id, o);
    }
    return o;
  };
  for (const target of mapping.targets) {
    const raw = bandEnergy(bands, target.band) * target.gain;
    switch (target.kind) {
      case 'x':
        ensure(target.nodeId).dx += raw * AUDIO_AXIS_UNIT;
        break;
      case 'y':
        ensure(target.nodeId).dy += raw * AUDIO_AXIS_UNIT;
        break;
      case 'z':
        ensure(target.nodeId).dz += raw * AUDIO_AXIS_UNIT;
        break;
      case 'scale':
        ensure(target.nodeId).scale += raw * AUDIO_SCALE_UNIT;
        break;
      case 'ring':
        ringValues.set(target.nodeId, clamp01((ringValues.get(target.nodeId) ?? 0) + raw));
        break;
    }
  }
  return { offsets, ringValues };
}

/**
 * A sensible starting mapping for a workflow: react on the SAMPLER orb (the
 * constellation's heart) with bass -> scale + ring, mid -> X drift, treble -> Y
 * drift. Falls back to the first node when there's no sampler; an empty workflow
 * yields no targets. Deterministic.
 */
export function DEFAULT_MAPPING(workflow: Workflow): AudioMapping {
  const sampler = workflow.nodes.find((n) => n.kind === 'sampler');
  const nodeId = sampler?.id ?? workflow.nodes[0]?.id ?? '';
  if (!nodeId) return { targets: [] };
  return {
    targets: [
      { band: 'bass', kind: 'scale', nodeId, gain: 1 },
      { band: 'bass', kind: 'ring', nodeId, gain: 1 },
      { band: 'mid', kind: 'x', nodeId, gain: 1 },
      { band: 'treble', kind: 'y', nodeId, gain: 1 },
    ],
  };
}
