/**
 * Pure orb-motion math for the Motion Engine. Maps an OrbMotion (style + speed +
 * amplitude) and a normalized value (`valueT`, 0..1) to a spatial offset from the
 * orb's base world position, at time `t` (SECONDS). No DOM / three.js — fully
 * deterministic and unit-testable.
 *
 * The returned offset is added to the node's base position by the 3D layer:
 *   pos = base + {dx, dy, dz};  orbScale = base * scale
 * A selected/expanded node stays a card and never gets an offset applied (the
 * caller skips it) — this fn itself is unconditional.
 */
import type { OrbMotion } from './types';

export interface MotionOffset {
  dx: number;
  dy: number;
  dz: number;
  /** multiplicative scale factor (1 = unchanged) */
  scale: number;
}

const IDENTITY: MotionOffset = { dx: 0, dy: 0, dz: 0, scale: 1 };

/**
 * Compute the spatial offset for an orb.
 *
 * - `orbit`: circle in the XZ plane, radius = amplitude · valueT, angular speed
 *   = speed (radians/sec). Value drives HOW FAR the orb swings out.
 * - `bob`: vertical sine on Y, dy = amplitude · sin(speed · t).
 * - `pulse`: no translation; scale breathes in ~[0.8, 1.4] centered on value,
 *   scale = 1 + amplitude · 0.5 · valueT · (1 + sin(speed · t)) / 2, then clamped.
 * - `drift`: slow Lissajous wander in XZ (different X/Z frequencies), scaled by
 *   amplitude · (0.5 + 0.5 · valueT) so louder orbs roam a little wider.
 * - `still`: identity (no motion).
 *
 * `valueT` is clamped to 0..1; a value <= 0 makes value-scaled styles hold still.
 */
export function motionOffset(orbMotion: OrbMotion, valueT: number, t: number): MotionOffset {
  const v = valueT < 0 ? 0 : valueT > 1 ? 1 : valueT;
  const { style, speed, amplitude } = orbMotion;

  switch (style) {
    case 'orbit': {
      const radius = amplitude * v;
      const angle = speed * t;
      return { dx: Math.cos(angle) * radius, dy: 0, dz: Math.sin(angle) * radius, scale: 1 };
    }
    case 'bob': {
      return { dx: 0, dy: amplitude * Math.sin(speed * t), dz: 0, scale: 1 };
    }
    case 'pulse': {
      const breathe = (1 + Math.sin(speed * t)) / 2; // 0..1
      const raw = 1 + amplitude * 0.5 * v * breathe;
      // Keep the visual within a tasteful ~0.8..1.4 range regardless of amplitude.
      const scale = raw < 0.8 ? 0.8 : raw > 1.4 ? 1.4 : raw;
      return { dx: 0, dy: 0, dz: 0, scale };
    }
    case 'drift': {
      const reach = amplitude * (0.5 + 0.5 * v);
      // Slow, incommensurate frequencies -> a wandering, non-repeating-looking path.
      const dx = Math.sin(speed * t * 0.7) * reach;
      const dz = Math.cos(speed * t * 0.4) * reach;
      return { dx, dy: 0, dz, scale: 1 };
    }
    case 'still':
    default:
      return { ...IDENTITY };
  }
}
