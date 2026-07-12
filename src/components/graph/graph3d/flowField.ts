/**
 * Fluid flow field for the mist/smoke layers (Universe planets + Graph orbs).
 * PURE: no DOM, no three.js — every term is a function of (position, time,
 * bodies, events), so the "fluid dynamics" are unit-testable and reduced-motion
 * can freeze them by freezing time. Particle positions are the only state the
 * callers keep.
 *
 * Velocity composition:
 *  - CURL of FBM value noise, taken in the dominant XZ plane: exactly
 *    divergence-free there (∂vx/∂x + ∂vz/∂z ≡ 0 by construction), which is what
 *    makes smoke read as incompressible swirl — plus a gentle independent
 *    vertical drift so wisps breathe.
 *  - WAKES: moving bodies drag mist along a gaussian velocity kernel.
 *  - PULSES: expanding radial rings from events (promotion), analytic decay,
 *    capped at MAX_PULSES (oldest dropped).
 *  - EDDY: a small rotational kernel around the hovered body.
 */

export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/** A body stirring the fluid: position, velocity (world/s), influence radius. */
export interface FlowBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
}

/** An expanding pressure ring (e.g. a promotion). t0 in ms (performance.now). */
export interface FlowPulse {
  x: number;
  y: number;
  z: number;
  t0: number;
  amp: number;
}

/** A rotational stir around a hovered body. */
export interface FlowEddy {
  x: number;
  y: number;
  z: number;
  strength: number;
  radius: number;
}

export interface FlowContext {
  bodies: readonly FlowBody[];
  pulses: readonly FlowPulse[];
  eddy: FlowEddy | null;
}

export const MAX_PULSES = 4;
/** Ring expansion speed (world units/s — Universe scale, ~planet radii). */
export const PULSE_SPEED = 9;
/** Pulse amplitude decay constant (seconds). */
export const PULSE_TAU = 0.45;
/** A pulse is dead past this age (seconds). */
export const PULSE_LIFETIME = 1.6;
/** Radial half-width of the pulse ring (world units). */
const PULSE_WIDTH = 1.4;

/** Curl-noise tuning: spatial frequency, drift speed, swirl strength. */
const CURL_FREQ = 0.22;
const CURL_TIME = 0.05;
const CURL_GAIN = 1.0;
const CURL_EPS = 0.35; // finite-difference step (world units)
/** Gentle vertical breathing, independent of the planar curl. */
const LIFT_GAIN = 0.18;

// ---- deterministic 3D value noise (no Math.random; matches the shader style) --

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Trilinear value noise in [0,1]. Pure and deterministic. */
export function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const tz = smooth(z - zi);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);
  return lerp(
    lerp(lerp(c000, c100, tx), lerp(c010, c110, tx), ty),
    lerp(lerp(c001, c101, tx), lerp(c011, c111, tx), ty),
    tz,
  );
}

/** Streamfunction ψ — time rides the y lane so the swirl slowly evolves. */
function psi(x: number, z: number, t: number): number {
  return valueNoise3(x * CURL_FREQ, t * CURL_TIME, z * CURL_FREQ);
}

/**
 * Compose the full fluid velocity at `p` (world) and `tSec` into `out`.
 * Allocation-free; returns `out`.
 */
export function velocityAt(
  px: number,
  py: number,
  pz: number,
  tSec: number,
  ctx: FlowContext,
  nowMs: number,
  out: Vec3Out,
): Vec3Out {
  // Planar curl of ψ: v = (∂ψ/∂z, 0, -∂ψ/∂x) — divergence-free in XZ.
  const dpz = (psi(px, pz + CURL_EPS, tSec) - psi(px, pz - CURL_EPS, tSec)) / (2 * CURL_EPS);
  const dpx = (psi(px + CURL_EPS, pz, tSec) - psi(px - CURL_EPS, pz, tSec)) / (2 * CURL_EPS);
  out.x = dpz * CURL_GAIN;
  out.z = -dpx * CURL_GAIN;
  // Independent gentle lift (breathing), centered around zero.
  out.y = (valueNoise3(px * CURL_FREQ + 31.7, tSec * CURL_TIME + 7.3, pz * CURL_FREQ) - 0.5) * LIFT_GAIN;

  // Wakes: moving bodies drag the fluid along.
  for (const b of ctx.bodies) {
    const speed2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    if (speed2 < 1e-8) continue;
    const dx = px - b.x;
    const dy = py - b.y;
    const dz = pz - b.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    const s2 = 2 * b.radius * b.radius;
    const g = Math.exp(-r2 / s2);
    out.x += b.vx * g;
    out.y += b.vy * g;
    out.z += b.vz * g;
  }

  // Pressure pulses: expanding rings pushing outward, decaying analytically.
  for (const pu of ctx.pulses) {
    const age = (nowMs - pu.t0) / 1000;
    if (age < 0 || age > PULSE_LIFETIME) continue;
    const dx = px - pu.x;
    const dy = py - pu.y;
    const dz = pz - pu.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < 1e-6) continue;
    const ring = r - PULSE_SPEED * age;
    const g = pu.amp * Math.exp(-age / PULSE_TAU) * Math.exp(-(ring * ring) / (2 * PULSE_WIDTH * PULSE_WIDTH));
    out.x += (dx / r) * g;
    out.y += (dy / r) * g;
    out.z += (dz / r) * g;
  }

  // Hover eddy: a tangential stir (up × radial) around the hovered body.
  const e = ctx.eddy;
  if (e && e.strength > 0) {
    const dx = px - e.x;
    const dz = pz - e.z;
    const r2 = dx * dx + dz * dz + (py - e.y) * (py - e.y);
    const g = e.strength * Math.exp(-r2 / (2 * e.radius * e.radius));
    // up(0,1,0) × radial(dx,·,dz) = (-dz, 0, dx)
    out.x += -dz * g;
    out.z += dx * g;
  }

  return out;
}

/** Append a pulse, dropping the oldest beyond MAX_PULSES. Returns a new array. */
export function pushPulse(pulses: readonly FlowPulse[], pulse: FlowPulse): FlowPulse[] {
  const next = [...pulses, pulse];
  return next.length > MAX_PULSES ? next.slice(next.length - MAX_PULSES) : next;
}

/**
 * Drop expired pulses. Allocation-free on the steady state (same reference
 * when nothing expired — and pulse-free IS the steady state, this runs every
 * animated frame); allocates only in the ≤1.6 s window after an event.
 */
export function prunePulses(pulses: readonly FlowPulse[], nowMs: number): readonly FlowPulse[] {
  if (pulses.length === 0) return pulses;
  let expired = false;
  for (let i = 0; i < pulses.length; i++) {
    if ((nowMs - pulses[i].t0) / 1000 > PULSE_LIFETIME) {
      expired = true;
      break;
    }
  }
  if (!expired) return pulses;
  return pulses.filter((p) => (nowMs - p.t0) / 1000 <= PULSE_LIFETIME);
}
