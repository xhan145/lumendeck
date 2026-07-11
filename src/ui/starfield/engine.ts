/**
 * Ambient starfield engine — PURE simulation (no DOM, no canvas in the
 * stepping path) shared by the app-wide background layer and the launch
 * splash. Deterministic: seeded mulberry32, no Math.random / Date.now; the
 * caller feeds dt. `stepStarfield` mutates state in place (no per-frame
 * allocations); `renderStarfield` is the only function that touches a 2D
 * context. Unit tests cover stepping/lifecycles (tests/starfield.test.ts).
 */

export interface Star {
  x: number; // normalized 0..1
  y: number;
  size: number; // px at dpr 1
  phase: number;
  speed: number; // twinkle rate (rad/s)
  driftX: number; // normalized units/s
  driftY: number;
  /** Precomputed fill style (no per-frame string allocation). */
  color: string;
}

export interface Dust {
  x: number;
  y: number;
  size: number;
  vx: number;
  vy: number;
  alpha: number;
}

export type ConstellationStage = 'drawing' | 'holding' | 'fading';

export interface Constellation {
  /** Star indices forming a chain (links = consecutive pairs). */
  chain: number[];
  stage: ConstellationStage;
  /** 0..1 draw-in progress across the whole chain. */
  progress: number;
  /** Seconds remaining in the current stage (holding/fading). */
  stageLeft: number;
}

export interface ShootingStar {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export interface StarfieldState {
  stars: Star[];
  dust: Dust[];
  constellation: Constellation | null;
  /** Seconds until the next constellation spawns (when none active). */
  constellationIn: number;
  shooting: ShootingStar;
  /** Seconds until the next shooting star (when inactive). */
  shootingIn: number;
  time: number;
  /** PRNG state (persisted so respawns stay deterministic). */
  rngSeed: number;
  constellationsEnabled: boolean;
}

export interface StarfieldOptions {
  seed?: number;
  starCount: number;
  dustCount: number;
  constellations?: boolean;
}

/** Max integration step (s) — tab restores can't fling the field. */
export const STARFIELD_MAX_DT = 0.05;

const DRAW_SPEED = 1 / 1.4; // constellation draw-in: ~1.4s for the full chain
const HOLD_S = 4.2;
const FADE_S = 1.6;
const CHAIN_MIN = 4;
const CHAIN_MAX = 6;
const SHOOTING_SPEED = 0.9; // normalized units/s
const STAR_TINTS = ['#9fd8ff', '#e8f1ff', '#ffe7c4'] as const;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One PRNG draw from the state (persists the advanced seed — deterministic). */
function nextRand(state: StarfieldState): number {
  state.rngSeed = (state.rngSeed + 0x6d2b79f5) >>> 0;
  let t = state.rngSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createStarfield(opts: StarfieldOptions): StarfieldState {
  const rand = mulberry32(opts.seed ?? 0x1f2e3d4c);
  const stars: Star[] = [];
  for (let i = 0; i < opts.starCount; i++) {
    stars.push({
      x: rand(),
      y: rand(),
      size: 0.6 + rand() * 1.8,
      phase: rand() * Math.PI * 2,
      speed: 0.4 + rand() * 1.6,
      driftX: (rand() - 0.5) * 0.004,
      driftY: (rand() - 0.5) * 0.003,
      color: STAR_TINTS[Math.floor(rand() * STAR_TINTS.length) % STAR_TINTS.length],
    });
  }
  const dust: Dust[] = [];
  for (let i = 0; i < opts.dustCount; i++) {
    dust.push({
      x: rand(),
      y: rand(),
      size: 0.4 + rand() * 0.9,
      vx: (rand() - 0.5) * 0.014,
      vy: -0.004 - rand() * 0.008, // dust rises gently
      alpha: 0.06 + rand() * 0.12,
    });
  }
  return {
    stars,
    dust,
    constellation: null,
    constellationIn: 1.5 + rand() * 2,
    shooting: { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0 },
    shootingIn: 5 + rand() * 8,
    time: 0,
    rngSeed: ((opts.seed ?? 0x1f2e3d4c) ^ 0x9e3779b9) >>> 0,
    constellationsEnabled: opts.constellations !== false,
  };
}

/** Nearest-neighbor chain of star indices starting from a seeded anchor. Pure. */
export function buildChain(stars: readonly Star[], anchor: number, length: number): number[] {
  const chain = [anchor];
  const used = new Set(chain);
  while (chain.length < length) {
    const from = stars[chain[chain.length - 1]];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < stars.length; i++) {
      if (used.has(i)) continue;
      const dx = stars[i].x - from.x;
      const dy = stars[i].y - from.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) break;
    chain.push(best);
    used.add(best);
  }
  return chain;
}

/** Advance the field by dt seconds (clamped). Mutates in place; returns state. */
export function stepStarfield(state: StarfieldState, dt: number): StarfieldState {
  const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, STARFIELD_MAX_DT) : 0;
  if (d === 0) return state;
  state.time += d;

  for (const s of state.stars) {
    s.x += s.driftX * d;
    s.y += s.driftY * d;
    if (s.x < 0) s.x += 1;
    else if (s.x > 1) s.x -= 1;
    if (s.y < 0) s.y += 1;
    else if (s.y > 1) s.y -= 1;
  }
  for (const p of state.dust) {
    p.x += p.vx * d;
    p.y += p.vy * d;
    if (p.x < 0) p.x += 1;
    else if (p.x > 1) p.x -= 1;
    if (p.y < 0) p.y += 1;
    else if (p.y > 1) p.y -= 1;
  }

  // Constellation lifecycle: spawn → draw-in → hold → fade → cooldown.
  if (state.constellationsEnabled) {
    const c = state.constellation;
    if (!c) {
      state.constellationIn -= d;
      if (state.constellationIn <= 0 && state.stars.length >= CHAIN_MAX) {
        const anchor = Math.floor(nextRand(state) * state.stars.length) % state.stars.length;
        const len = CHAIN_MIN + Math.floor(nextRand(state) * (CHAIN_MAX - CHAIN_MIN + 1));
        state.constellation = { chain: buildChain(state.stars, anchor, len), stage: 'drawing', progress: 0, stageLeft: 0 };
      }
    } else if (c.stage === 'drawing') {
      c.progress = Math.min(1, c.progress + d * DRAW_SPEED);
      if (c.progress >= 1) {
        c.stage = 'holding';
        c.stageLeft = HOLD_S;
      }
    } else if (c.stage === 'holding') {
      c.stageLeft -= d;
      if (c.stageLeft <= 0) {
        c.stage = 'fading';
        c.stageLeft = FADE_S;
      }
    } else {
      c.stageLeft -= d;
      if (c.stageLeft <= 0) {
        state.constellation = null;
        state.constellationIn = 3 + nextRand(state) * 5;
      }
    }
  }

  // Shooting star: at most one, bounded life, seeded respawn interval.
  const sh = state.shooting;
  if (!sh.active) {
    state.shootingIn -= d;
    if (state.shootingIn <= 0) {
      sh.active = true;
      sh.x = 0.1 + nextRand(state) * 0.8;
      sh.y = nextRand(state) * 0.3;
      const angle = Math.PI * (0.15 + nextRand(state) * 0.2); // down-right diagonal
      sh.vx = Math.cos(angle) * SHOOTING_SPEED;
      sh.vy = Math.sin(angle) * SHOOTING_SPEED;
      sh.maxLife = 0.7 + nextRand(state) * 0.4;
      sh.life = sh.maxLife;
    }
  } else {
    sh.x += sh.vx * d;
    sh.y += sh.vy * d;
    sh.life -= d;
    if (sh.life <= 0 || sh.x > 1.2 || sh.y > 1.2) {
      sh.active = false;
      state.shootingIn = 6 + nextRand(state) * 10;
    }
  }
  return state;
}

/**
 * Draw the field. `alpha` scales the whole layer (splash choreography /
 * ambient calm). The caller owns clearing + dpr transform.
 */
export function renderStarfield(
  ctx: CanvasRenderingContext2D,
  state: StarfieldState,
  w: number,
  h: number,
  alpha = 1,
): void {
  ctx.save();
  // Dust: dim rising motes.
  for (const p of state.dust) {
    ctx.globalAlpha = p.alpha * alpha;
    ctx.fillStyle = '#8fb8d8';
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  // Stars: twinkling core + faint halo.
  for (const s of state.stars) {
    const tw = 0.55 + 0.45 * Math.sin(state.time * s.speed + s.phase);
    const r = s.size * (0.7 + 0.3 * tw);
    const x = s.x * w;
    const y = s.y * h;
    ctx.fillStyle = s.color;
    ctx.globalAlpha = 0.1 * tw * alpha;
    ctx.beginPath();
    ctx.arc(x, y, r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = (0.35 + 0.55 * tw) * alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Constellation: sequential line draw-in across the chain.
  const c = state.constellation;
  if (c && c.chain.length > 1) {
    const links = c.chain.length - 1;
    const lineAlpha = (c.stage === 'fading' ? Math.max(0, c.stageLeft / FADE_S) : 1) * 0.4 * alpha;
    ctx.strokeStyle = '#7fd4f0';
    ctx.lineWidth = 1;
    ctx.globalAlpha = lineAlpha;
    ctx.beginPath();
    const total = c.progress * links;
    for (let i = 0; i < links; i++) {
      const a = state.stars[c.chain[i]];
      const b = state.stars[c.chain[i + 1]];
      const seg = Math.min(1, Math.max(0, total - i));
      if (seg <= 0) break;
      // Seam guard: stars wrap at the [0,1] edges, so a chained star crossing a
      // screen edge mid-lifecycle would snap its link into a viewport-spanning
      // streak. A real constellation link is always short — skip any that isn't.
      if (Math.abs(b.x - a.x) > 0.5 || Math.abs(b.y - a.y) > 0.5) continue;
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo((a.x + (b.x - a.x) * seg) * w, (a.y + (b.y - a.y) * seg) * h);
    }
    ctx.stroke();
  }
  // Shooting star: bright head + velocity tail.
  const sh = state.shooting;
  if (sh.active) {
    const fade = Math.max(0, sh.life / sh.maxLife);
    const x = sh.x * w;
    const y = sh.y * h;
    ctx.strokeStyle = '#e8f1ff';
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.7 * fade * alpha;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - sh.vx * 0.09 * w, y - sh.vy * 0.09 * h);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.9 * fade * alpha;
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---- Splash choreography ----------------------------------------------------

export interface SplashPhase {
  /** Star layer opacity 0..1 (staggered twinkle-in). */
  starsAlpha: number;
  /** Constellation draw-in 0..1. */
  linesProgress: number;
  /** Wordmark opacity 0..1. */
  wordmarkAlpha: number;
  /** Lift-away 0..1 (overlay translate + fade). */
  liftT: number;
  done: boolean;
}

export const SPLASH_TOTAL_MS = 2450;

const ramp = (t: number, a: number, b: number): number => {
  if (t <= a) return 0;
  if (t >= b) return 1;
  const x = (t - a) / (b - a);
  return x * x * (3 - 2 * x); // smoothstep
};

/** Pure choreography curve for the launch splash (t in ms since start). */
export function splashPhase(tMs: number): SplashPhase {
  const t = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
  return {
    starsAlpha: ramp(t, 200, 900),
    linesProgress: ramp(t, 800, 1800),
    wordmarkAlpha: ramp(t, 1500, 2050),
    liftT: ramp(t, 2150, SPLASH_TOTAL_MS),
    done: t >= SPLASH_TOTAL_MS,
  };
}
