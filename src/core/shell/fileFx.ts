import type { FileFxMode } from '../../state/appSettings';

export interface FileFxPreset {
  readonly backgroundStars: number;
  readonly ambientDust: number;
  readonly clusterMist: number;
  readonly bloom: boolean;
  readonly bloomStrength: number;
  readonly pixelRatioCap: number;
}

export const FILE_FX_PRESETS: Readonly<Record<FileFxMode, FileFxPreset>> = {
  off: {
    backgroundStars: 280, ambientDust: 0, clusterMist: 0,
    bloom: false, bloomStrength: 0, pixelRatioCap: 1.25,
  },
  balanced: {
    backgroundStars: 1100, ambientDust: 260, clusterMist: 25,
    bloom: false, bloomStrength: 0, pixelRatioCap: 1.5,
  },
  cinematic: {
    backgroundStars: 2400, ambientDust: 820, clusterMist: 85,
    bloom: true, bloomStrength: 0.95, pixelRatioCap: 1.5,
  },
};

export interface ParticleCloud {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  phases: Float32Array;
  drifts: Float32Array;
}

export type ParticleRegion = 'distant' | 'dust';

export function stableFileHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Pure, seeded point-cloud geometry. Dust moves visually through a GPU shader,
 * not through JavaScript edits to file-star positions. No Math.random().
 */
export function makeParticleCloud(count: number, region: ParticleRegion, seed = 0x4c554d45): ParticleCloud {
  const n = Math.max(0, Math.min(6000, Math.floor(Number.isFinite(count) ? count : 0)));
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const phases = new Float32Array(n);
  const drifts = new Float32Array(n);
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const palette = region === 'distant'
    ? [[0.54, 0.46, 0.79], [0.81, 0.78, 0.98], [0.36, 0.52, 0.71]]
    : [[0.49, 0.32, 0.78], [0.69, 0.53, 0.94], [0.35, 0.57, 0.71]];

  for (let i = 0; i < n; i++) {
    if (region === 'distant') {
      positions[i * 3] = (rand() - 0.5) * 120;
      positions[i * 3 + 1] = (rand() - 0.5) * 72;
      positions[i * 3 + 2] = -14 - rand() * 72;
      sizes[i] = 2.3 + rand() * 4.3;
      drifts[i] = 0.05 + rand() * 0.16;
    } else {
      positions[i * 3] = (rand() - 0.5) * 33;
      positions[i * 3 + 1] = (rand() - 0.5) * 21;
      positions[i * 3 + 2] = (rand() - 0.5) * 22;
      sizes[i] = 3 + rand() * 10;
      drifts[i] = 0.15 + rand() * 0.55;
    }
    const c = palette[Math.floor(rand() * palette.length)];
    const brightness = 0.66 + rand() * 0.34;
    for (let j = 0; j < 3; j++) colors[i * 3 + j] = c[j] * brightness;
    phases[i] = rand() * Math.PI * 2;
  }

  return { positions, colors, sizes, phases, drifts };
}

export interface PerformanceGovernor {
  /** Updates the sustained slow-frame meter; true when cosmetic FX should shed load. */
  feed(frameMs: number): boolean;
  degraded(): boolean;
}

/** One-way downgrade per scene; user preference remains intact on disk. */
export function makeFileFxGovernor(): PerformanceGovernor {
  let slowMs = 0;
  let dropped = false;
  return {
    feed(frameMs) {
      if (dropped || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 300) return false;
      slowMs = frameMs >= 38 ? slowMs + frameMs : Math.max(0, slowMs - frameMs * 1.5);
      if (slowMs >= 2400) {
        dropped = true;
        return true;
      }
      return false;
    },
    degraded: () => dropped,
  };
}
