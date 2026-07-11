/**
 * Deterministic orbital mechanics for the Open Constellation. PURE: no DOM, no
 * three.js — positions are plain {x,y,z} so the math is unit-testable and the
 * renderer stays a thin consumer.
 *
 * Every satellite gets a distinct radius, inclination, phase, speed, and scale
 * derived ONLY from (node id, sibling index, ring count) via a string hash — the
 * same tree always produces the same sky, with no Math.random anywhere. Speeds
 * follow a gentle Kepler-like falloff (outer bodies orbit slower), keeping
 * satellites selectable. Composition stays legible: radii step outward per
 * sibling; inclinations stay within a controlled band so the system reads as a
 * loose disc, never a perfect flat ring and never a chaotic swarm.
 */

export interface OrbitParams {
  /** Orbit radius in world units. */
  radius: number;
  /** Orbit-plane tilt from the ecliptic, radians (bounded band). */
  inclination: number;
  /** Ascending-node rotation of the orbit plane, radians. */
  node: number;
  /** Initial angle along the orbit, radians. */
  phase: number;
  /** Angular speed, radians/second (Kepler-ish: slower when farther). */
  speed: number;
  /** Relative body scale (0.55..1.15), boosted by node strength. */
  scale: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** FNV-1a 32-bit — tiny, stable string hash for deterministic variation. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Map a hash + lane to a stable float in [0, 1). */
function unitHash(seed: string, lane: number): number {
  return (hashString(`${seed}:${lane}`) % 100000) / 100000;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.399963 rad

/** Base distance of the innermost satellite ring from the planet center. */
export const ORBIT_BASE_RADIUS = 3.2;
/** Radial step between successive satellite rings. */
export const ORBIT_RADIUS_STEP = 1.15;
/** Max |inclination| of any orbit plane (keeps the system disc-like + legible). */
export const ORBIT_MAX_INCLINATION = 0.42;

/**
 * Deterministic orbital parameters for the `index`-th of `count` satellites.
 * `seedId` is the satellite's node id; `strength` (0..1) boosts scale.
 */
export function orbitParamsFor(
  index: number,
  count: number,
  seedId: string,
  strength = 0.5,
): OrbitParams {
  const jitter = unitHash(seedId, 1); // stable per node
  const radius = ORBIT_BASE_RADIUS + index * ORBIT_RADIUS_STEP + jitter * 0.6;
  // Alternate tilts above/below the ecliptic within the legibility band.
  const inclination =
    (unitHash(seedId, 2) * 2 - 1) * ORBIT_MAX_INCLINATION * (0.4 + 0.6 * (index / Math.max(count - 1, 1)));
  const node = unitHash(seedId, 3) * Math.PI * 2;
  // Golden-angle spacing prevents clumping even for identical hashes.
  const phase = index * GOLDEN_ANGLE + unitHash(seedId, 4) * 0.8;
  // Kepler-ish: speed ∝ r^-1.5, tuned slow enough to click comfortably.
  const speed = 0.22 / Math.pow(radius / ORBIT_BASE_RADIUS, 1.5);
  const scale = 0.55 + 0.35 * unitHash(seedId, 5) + 0.25 * Math.min(Math.max(strength, 0), 1);
  return { radius, inclination, node, phase, speed, scale };
}

/**
 * Position along an orbit at time `t` seconds: a circle in a plane tilted by
 * `inclination` about X, then rotated by `node` about Y. |result| === radius.
 */
export function orbitPosition(p: OrbitParams, t: number, out?: Vec3Like): Vec3Like {
  return orbitPointAt(p, p.phase + p.speed * t, out);
}

/** Point on the orbit circle at absolute angle `theta` (for drawing orbit lines). */
export function orbitPointAt(p: OrbitParams, theta: number, out?: Vec3Like): Vec3Like {
  // Circle in the XZ plane.
  const cx = Math.cos(theta) * p.radius;
  const cz = Math.sin(theta) * p.radius;
  // Tilt about X (inclination): y' = -z sin(i)... rotate (0, cz) in YZ.
  const cosI = Math.cos(p.inclination);
  const sinI = Math.sin(p.inclination);
  const y1 = -cz * sinI;
  const z1 = cz * cosI;
  // Rotate about Y (ascending node).
  const cosN = Math.cos(p.node);
  const sinN = Math.sin(p.node);
  const x2 = cx * cosN + z1 * sinN;
  const z2 = -cx * sinN + z1 * cosN;
  const v = out ?? { x: 0, y: 0, z: 0 };
  v.x = x2;
  v.y = y1;
  v.z = z2;
  return v;
}
