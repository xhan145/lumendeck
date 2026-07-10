/**
 * Quality tiers + adaptive degradation for the 3D constellation. PURE — no DOM,
 * no three.js; timestamps are injected so every rule here is unit-testable
 * (tests/quality.test.ts).
 *
 * Two layers of control:
 *  1. The USER level (appSettings.graph3dEffects) — intent. Data encodings
 *     (wells, anomaly rings, luminosity) follow the user level only.
 *  2. The ADAPTIVE cap — measured frame performance can lower the EFFECTIVE
 *     level for the expensive ambient layers (particles, pulses, bloom,
 *     starfield, fabric waves/density) without ever removing a data encoding.
 */

export type EffectsLevel = 'off' | 'minimal' | 'standard' | 'rich' | 'cinematic';

/** Cheap → expensive. Index = severity rank used by min/step logic. */
export const LEVEL_ORDER: readonly EffectsLevel[] = ['off', 'minimal', 'standard', 'rich', 'cinematic'];

export function levelRank(level: EffectsLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/** The cheaper of two levels (user intent ∩ adaptive cap). */
export function minLevel(a: EffectsLevel, b: EffectsLevel): EffectsLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

/** Everything the render layers need to know about one effects level. */
export interface QualityFeatures {
  /** Fabric plane density tier; null = no fabric at all. */
  fabricTier: 'minimal' | 'standard' | 'rich' | 'cinematic' | null;
  /** Gravity-dust particle budget (0 = layer absent). */
  particleCount: number;
  /** Energy pulses per idle workflow edge (0 = layer absent). */
  pulsesPerEdge: number;
  /** Full post pipeline (bloom + filmic tone mapping + opaque backdrop). */
  bloom: boolean;
  /** UnrealBloomPass strength when bloom is on. */
  bloomStrength: number;
  /** Background star count (0 = layer absent). Static — costs one draw. */
  starfield: number;
  /** Ambient fabric micro-wave amplitude, world units (0 = static sheet). */
  fabricWaveAmp: number;
}

const FEATURES: Record<EffectsLevel, QualityFeatures> = {
  off: {
    fabricTier: null,
    particleCount: 0,
    pulsesPerEdge: 0,
    bloom: false,
    bloomStrength: 0,
    starfield: 0,
    fabricWaveAmp: 0,
  },
  minimal: {
    fabricTier: 'minimal',
    particleCount: 0,
    pulsesPerEdge: 0,
    bloom: false,
    bloomStrength: 0,
    starfield: 0,
    fabricWaveAmp: 0,
  },
  standard: {
    fabricTier: 'standard',
    particleCount: 1000,
    pulsesPerEdge: 2,
    bloom: false,
    bloomStrength: 0,
    starfield: 0,
    fabricWaveAmp: 0,
  },
  rich: {
    fabricTier: 'rich',
    particleCount: 2600,
    pulsesPerEdge: 3,
    bloom: false,
    bloomStrength: 0,
    starfield: 900,
    fabricWaveAmp: 4,
  },
  cinematic: {
    fabricTier: 'cinematic',
    particleCount: 4500,
    pulsesPerEdge: 4,
    bloom: true,
    bloomStrength: 0.55,
    starfield: 1400,
    fabricWaveAmp: 6,
  },
};

export function featuresFor(level: EffectsLevel): QualityFeatures {
  return FEATURES[level];
}

/**
 * Reduced-motion policy (prefers-reduced-motion OR any future manual toggle):
 * every continuously-ANIMATED ambient layer goes quiet; static data encodings
 * (wells, contour lines, anomaly rings, ring arcs, starfield, luminosity
 * snapshot) are untouched — the scene stays informative, just calm.
 */
export interface MotionPolicy {
  particles: boolean;
  pulses: boolean;
  ripples: boolean;
  fabricWaves: boolean;
}

export function motionPolicy(reducedMotion: boolean): MotionPolicy {
  const on = !reducedMotion;
  return { particles: on, pulses: on, ripples: on, fabricWaves: on };
}

/**
 * Clamp an animation delta (seconds). A restored/back-grounded tab hands the
 * loops a huge dt; clamping keeps integrators from flinging particles away.
 * Shared by every animated layer so the rule is stated (and tested) once.
 */
export const MAX_DELTA_S = 0.05;

export function clampDelta(dt: number): number {
  if (!Number.isFinite(dt) || dt < 0) return 0;
  return Math.min(dt, MAX_DELTA_S);
}

// ---- adaptive quality controller -------------------------------------------

export interface AdaptiveQualityOptions {
  /** Frame budget in ms; sustained frames above this trigger a downgrade. */
  budgetMs?: number;
  /** How long (ms) the EMA must stay over budget before ONE downgrade step. */
  holdMs?: number;
  /** How long (ms) of comfortably-fast frames before ONE recovery step. */
  recoverMs?: number;
  /** EMA must be below budget * this factor to count as "comfortably fast". */
  recoverFactor?: number;
  /** The cap never drops below this level (data encodings stay renderable). */
  floor?: EffectsLevel;
  /** Ignore samples above this (idle dirty-flag gaps are not slow frames). */
  maxSampleMs?: number;
  /** EMA smoothing factor. */
  emaAlpha?: number;
}

export interface AdaptiveQuality {
  /**
   * Feed one rendered frame's delta (ms since the previous render) at `now`
   * (ms). Returns true when the cap CHANGED (caller re-applies features).
   */
  feed(frameMs: number, now: number): boolean;
  /** Current adaptive ceiling. */
  cap(): EffectsLevel;
  /** The effective level for expensive layers: min(user, cap). */
  effective(user: EffectsLevel): EffectsLevel;
  /** Smoothed frame time (diagnostics). */
  emaMs(): number;
}

/**
 * Hysteresis rules (no rapid oscillation):
 *  - Downgrade: EMA over budget continuously for `holdMs` → cap drops ONE step
 *    (never below `floor`), and both timers reset.
 *  - Recover: EMA under budget*recoverFactor continuously for `recoverMs` →
 *    cap rises ONE step. Recovery is slow by construction (recoverMs >> holdMs)
 *    and each step re-arms the timer, so climbing back is gradual.
 *  - Idle gaps (dt > maxSampleMs — the dirty-flag scheduler sleeping) are NOT
 *    slow frames; they are ignored and reset the violation window.
 */
export function createAdaptiveQuality(opts?: AdaptiveQualityOptions): AdaptiveQuality {
  const budgetMs = opts?.budgetMs ?? 25; // ~40fps floor before degrading
  const holdMs = opts?.holdMs ?? 2500;
  const recoverMs = opts?.recoverMs ?? 15000;
  const recoverFactor = opts?.recoverFactor ?? 0.7;
  const floor = opts?.floor ?? 'minimal';
  const maxSampleMs = opts?.maxSampleMs ?? 250;
  const alpha = opts?.emaAlpha ?? 0.12;
  const floorRank = levelRank(floor);

  let capRank = LEVEL_ORDER.length - 1; // start fully open
  let ema = 0;
  let seeded = false;
  let overSince: number | null = null;
  let underSince: number | null = null;

  return {
    feed(frameMs: number, now: number): boolean {
      if (!Number.isFinite(frameMs) || frameMs <= 0) return false;
      if (frameMs > maxSampleMs) {
        // A gap, not a frame: the scene was asleep. Reset both windows.
        overSince = null;
        underSince = null;
        return false;
      }
      ema = seeded ? alpha * frameMs + (1 - alpha) * ema : frameMs;
      seeded = true;

      if (ema > budgetMs) {
        underSince = null;
        if (overSince == null) overSince = now;
        if (now - overSince >= holdMs && capRank > floorRank) {
          capRank--;
          overSince = null;
          underSince = null;
          return true;
        }
      } else {
        overSince = null;
        if (ema < budgetMs * recoverFactor) {
          if (underSince == null) underSince = now;
          if (now - underSince >= recoverMs && capRank < LEVEL_ORDER.length - 1) {
            capRank++;
            underSince = null; // re-arm: each recovery step takes another full window
            return true;
          }
        } else {
          underSince = null;
        }
      }
      return false;
    },
    cap: () => LEVEL_ORDER[capRank],
    effective: (user) => minLevel(user, LEVEL_ORDER[capRank]),
    emaMs: () => ema,
  };
}
