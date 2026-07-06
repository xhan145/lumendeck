import type { ControlSlot } from './types';

/** The seven common ControlNet guidance types LumenDeck supports. */
export type ControlNetType = ControlSlot['type'];

/** Model families that have ControlNet weights available. */
export type ControlNetFamily = 'SD1.5' | 'SD2.1' | 'SDXL';

export const CONTROLNET_TYPES: ControlNetType[] = [
  'canny',
  'depth',
  'pose',
  'scribble',
  'lineart',
  'softedge',
  'tile',
];

/** Short display names for messages ('Depth is not available…'). */
export const CONTROLNET_TYPE_NAMES: Record<ControlNetType, string> = {
  canny: 'Canny',
  depth: 'Depth',
  pose: 'Pose',
  scribble: 'Scribble',
  lineart: 'Lineart',
  softedge: 'Soft edge',
  tile: 'Tile',
};

/** Select-option labels for the rack UI. */
export const CONTROLNET_TYPE_LABELS: Record<ControlNetType, string> = {
  canny: 'Canny (edges)',
  depth: 'Depth',
  pose: 'Pose',
  scribble: 'Scribble',
  lineart: 'Lineart',
  softedge: 'Soft edge',
  tile: 'Tile',
};

/**
 * Which ControlNet types have published weights per model family. Pure TS
 * mirror of the bridge's CONTROLNET_MODELS map so the health checker stays
 * fetch-free; the bridge remains the render-time source of truth.
 */
export const CONTROLNET_CAPABILITIES: Record<ControlNetFamily, ControlNetType[]> = {
  'SD1.5': ['canny', 'depth', 'pose', 'scribble', 'lineart', 'softedge', 'tile'],
  'SD2.1': ['canny', 'depth', 'pose'],
  SDXL: ['canny', 'depth', 'pose', 'scribble', 'tile'],
};

/**
 * Best-effort family guess from a shelf/model id string. Mirrors the bridge's
 * estimate_family heuristics: 'xl' wins first, then SD2 markers, else SD1.5.
 */
export function estimateFamilyFromModelId(id: string): ControlNetFamily {
  const s = (id || '').toLowerCase();
  if (s.includes('xl')) return 'SDXL';
  if (s.includes('sd-turbo') || s.includes('sd2') || s.includes('v2')) return 'SD2.1';
  return 'SD1.5';
}

export function supportedTypes(family: ControlNetFamily): ControlNetType[] {
  return CONTROLNET_CAPABILITIES[family];
}
