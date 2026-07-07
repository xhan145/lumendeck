/**
 * Persisted "Audio" slice for Audio Reactivity (Phase 3). Owns the slice SHAPE +
 * hydration so the store stays lean and OLD persisted state (which predates this
 * feature) loads gracefully — a missing slice seeds a default mapping.
 *
 * Persisted: `mapping` + `sensitivity` ONLY. `running`/`source` are NEVER
 * persisted, so a reload NEVER auto-listens to the microphone (a hard privacy
 * requirement). See docs/superpowers/specs/2026-07-06-audio-reactivity-phase3-design.md.
 */
import type { Workflow } from '../core/types';
import {
  DEFAULT_MAPPING,
  type AudioBand,
  type AudioMapping,
  type AudioTarget,
  type AudioTargetKind,
} from '../core/audio/mapping';

/** Which source kind is currently selected/live (null = none). */
export type AudioSourceKind = 'file' | 'mic' | 'tone';

export interface AudioState {
  /** the live source kind, or null when stopped (NEVER persisted) */
  source: AudioSourceKind | null;
  /** true while the engine is analysing (NEVER persisted) */
  running: boolean;
  /** the editable band -> orb-channel mapping (persisted) */
  mapping: AudioMapping;
  /** global gain applied to every band before mapping (persisted) */
  sensitivity: number;
}

/** Sensitivity slider bounds. */
export const SENSITIVITY_MIN = 0.2;
export const SENSITIVITY_MAX = 4;
export const DEFAULT_SENSITIVITY = 1;

const BANDS: AudioBand[] = ['bass', 'mid', 'treble', 'level'];
const KINDS: AudioTargetKind[] = ['x', 'y', 'z', 'ring', 'scale'];

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Fresh default audio state for a workflow (settled, not listening). */
export function defaultAudioState(workflow: Workflow): AudioState {
  return {
    source: null,
    running: false,
    mapping: DEFAULT_MAPPING(workflow),
    sensitivity: DEFAULT_SENSITIVITY,
  };
}

/** Validate one persisted target; returns null when malformed. */
function hydrateTarget(raw: unknown): AudioTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<AudioTarget>;
  if (typeof t.nodeId !== 'string') return null;
  if (!BANDS.includes(t.band as AudioBand)) return null;
  if (!KINDS.includes(t.kind as AudioTargetKind)) return null;
  const gain = typeof t.gain === 'number' && Number.isFinite(t.gain) ? t.gain : 1;
  return { band: t.band as AudioBand, kind: t.kind as AudioTargetKind, nodeId: t.nodeId, gain };
}

/** Sanitize a persisted mapping; returns null when it isn't a usable shape. */
function hydrateMapping(raw: unknown): AudioMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<AudioMapping>;
  if (!Array.isArray(m.targets)) return null;
  const targets = m.targets.map(hydrateTarget).filter((t): t is AudioTarget => t !== null);
  return { targets };
}

/**
 * Additive hydration: only `mapping` + `sensitivity` are read back; `source` and
 * `running` are ALWAYS reset to null/false so a reload never resumes listening.
 * A missing/invalid slice falls back to the workflow's default mapping.
 */
export function hydrateAudio(
  persisted: { mapping?: AudioMapping; sensitivity?: number } | undefined,
  workflow: Workflow,
): AudioState {
  const base = defaultAudioState(workflow);
  if (!persisted || typeof persisted !== 'object') return base;
  const mapping = hydrateMapping(persisted.mapping) ?? base.mapping;
  const sensitivity =
    typeof persisted.sensitivity === 'number' && Number.isFinite(persisted.sensitivity)
      ? clamp(persisted.sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX)
      : base.sensitivity;
  return { source: null, running: false, mapping, sensitivity };
}
