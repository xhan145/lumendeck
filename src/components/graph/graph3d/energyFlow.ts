import * as THREE from 'three';
import { clampDelta } from './quality';

/**
 * Directed workflow energy: light pulses that travel each wire from its source
 * socket to its destination, making the graph read as a system TRANSMITTING
 * work rather than a static diagram.
 *
 * Data encoding (the standing rule — no decorative noise):
 *  - pulse EXISTENCE + direction  → the edge itself (workflow topology)
 *  - pulse count + brightness     → endpoint activity (nodeMeta recency)
 *  - pulse color                  → the wire's socket type color
 *  - slow, dimmed, jittery pulses → a health ERROR on either endpoint
 *
 * ONE Points object carries every pulse (a single draw call): per-pulse
 * position/color/energy attributes are rewritten in `advance`; no objects are
 * created per pulse or per frame. All the math (bezier sampling, pulse
 * advancement, density mapping) is PURE and unit-tested.
 */

/** Hard capacity: pulses beyond this are dropped (warned once by the caller). */
export const MAX_PULSES = 512;
/** Pulse travel time budget: seconds for one full wire traversal at activity 0. */
const BASE_TRAVEL_S = 3.2;
/** At activity 1 a pulse crosses this many times faster. */
const ACTIVITY_SPEEDUP = 2.4;
/** Blocked (error-endpoint) pulses crawl and dim. */
const BLOCKED_SPEED_FACTOR = 0.3;
const BLOCKED_ENERGY = 0.22;

/** Quadratic bezier point at t — mirrors scene.ts wireCurve exactly. Pure. */
export function bezierPoint(
  ax: number, ay: number, az: number,
  cx: number, cy: number, cz: number,
  bx: number, by: number, bz: number,
  t: number,
): { x: number; y: number; z: number } {
  const u = 1 - t;
  const w0 = u * u;
  const w1 = 2 * u * t;
  const w2 = t * t;
  return {
    x: w0 * ax + w1 * cx + w2 * bx,
    y: w0 * ay + w1 * cy + w2 * by,
    z: w0 * az + w1 * cz + w2 * bz,
  };
}

/** Pulses an edge deserves: base for existing, +extra with endpoint activity. Pure. */
export function pulseCountFor(activity: number, basePulses: number): number {
  if (basePulses <= 0) return 0;
  const a = Math.min(1, Math.max(0, activity));
  return basePulses + Math.round(a * basePulses);
}

/** Advance a pulse's phase t (wraps in [0,1)). Pure. */
export function advancePulse(t: number, dt: number, activity: number, blocked: boolean): number {
  const a = Math.min(1, Math.max(0, activity));
  let speed = (1 / BASE_TRAVEL_S) * (1 + a * (ACTIVITY_SPEEDUP - 1));
  if (blocked) speed *= BLOCKED_SPEED_FACTOR;
  const next = t + dt * speed;
  return next - Math.floor(next); // wrap
}

/** One wire's flow parameters (endpoints in world space + its data channels). */
export interface FlowEdge {
  /** Stable edge id (geometry updates during playback address by id). */
  id: string;
  /** Source socket / orb surface point. */
  ax: number; ay: number; az: number;
  /** Bezier control point (same as the rendered wire's). */
  cx: number; cy: number; cz: number;
  /** Destination socket / orb surface point. */
  bx: number; by: number; bz: number;
  /** Wire color (concrete hex — resolve CSS vars first). */
  color: string;
  /** Endpoint activity 0..1 (max of the two nodes' luminosity). */
  activity: number;
  /** True when either endpoint carries a health ERROR. */
  blocked: boolean;
}

export interface EnergyFlow {
  /** The Points object to add to the scene. */
  readonly points: THREE.Points;
  /**
   * Rebuild pulse assignments from the current edges. Deterministic phases
   * (hash of edge id + pulse index) so identical graphs animate identically.
   * Returns the number of edges whose pulses were DROPPED by the capacity cap.
   */
  setEdges(edges: readonly FlowEdge[], pulsesPerEdge: number): number;
  /** Move an edge's curve (live wire rerouting during playback/audio). */
  updateGeometry(edgeId: string, ax: number, ay: number, az: number, cx: number, cy: number, cz: number, bx: number, by: number, bz: number): void;
  /** True when any pulse exists (the ambient loop keys off this). */
  active(): boolean;
  /** Advance every pulse and rewrite the GPU buffers. */
  advance(dt: number): void;
  /** Remove from parent + dispose geometry/material (idempotent). */
  dispose(): void;
}

const FLOW_VERTEX_SHADER = /* glsl */ `
  uniform float uSize;
  in vec3 aColor;
  in float aEnergy;
  out vec3 vColor;
  out float vEnergy;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(uSize * (0.7 + aEnergy) * (320.0 / max(-mv.z, 1.0)), 22.0);
    vColor = aColor;
    vEnergy = aEnergy;
    gl_Position = projectionMatrix * mv;
  }
`;

const FLOW_FRAGMENT_SHADER = /* glsl */ `
  in vec3 vColor;
  in float vEnergy;
  out vec4 fragColor;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d2 = dot(q, q);
    if (d2 > 0.25) discard;
    float core = exp(-d2 * 30.0);
    float halo = exp(-d2 * 7.0) * 0.3;
    // Energized pulses whiten slightly at the core — reads as heat, keeps the
    // socket hue in the halo so the data color survives.
    vec3 col = mix(vColor, vec3(1.0), core * vEnergy * 0.35);
    fragColor = vec4(col * (0.5 + 0.7 * vEnergy), (core + halo) * (0.35 + 0.65 * vEnergy));
  }
`;

/** Deterministic 0..1 hash from a string + index (stable pulse phases). */
function phaseHash(id: string, index: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h = (h + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  return (h >>> 8) / 16777216;
}

export function createEnergyFlow(): EnergyFlow {
  const positions = new Float32Array(MAX_PULSES * 3);
  const colors = new Float32Array(MAX_PULSES * 3);
  const energies = new Float32Array(MAX_PULSES);
  // Per-pulse simulation state (flat, no per-frame allocation).
  const phase = new Float32Array(MAX_PULSES);
  const pulseEdge = new Int32Array(MAX_PULSES);
  // Per-edge curve control points (9 floats: a, c, b) + channels.
  const edgeGeom = new Float32Array(MAX_PULSES * 9); // ≤ one edge per pulse
  const edgeActivity = new Float32Array(MAX_PULSES);
  const edgeBlocked = new Uint8Array(MAX_PULSES);
  const edgeIndexById = new Map<string, number>();
  let pulseCount = 0;
  let edgeCount = 0;
  // Wobble clock for blocked-edge jitter (deterministic, bounded).
  let clock = 0;

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aColor', colAttr);
  const energyAttr = new THREE.BufferAttribute(energies, 1);
  energyAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aEnergy', energyAttr);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader: FLOW_VERTEX_SHADER,
    fragmentShader: FLOW_FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uSize: { value: 13 } },
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 1; // over the wires so pulses ride on top of the line

  const color = new THREE.Color();

  return {
    points,
    setEdges(edges, pulsesPerEdge) {
      // Snapshot the in-flight phase of each surviving pulse, keyed by edge id +
      // its k-index within that edge. setEdges re-runs on common interactions
      // (node select, activity/health commits), so WITHOUT this a pulse that has
      // travelled to phase ~0.6 would teleport back to its seed phase every time,
      // visibly restarting the flow. Pulses are laid out consecutively per edge
      // (outer edge loop, inner k loop), so scanning in pi order gives k order.
      // This runs only on graph-change commits — never in the per-frame hot loop.
      const prevPhases = new Map<string, number[]>();
      if (pulseCount > 0) {
        const idByIndex: (string | undefined)[] = [];
        for (const [id, idx] of edgeIndexById) idByIndex[idx] = id;
        for (let pi = 0; pi < pulseCount; pi++) {
          const id = idByIndex[pulseEdge[pi]];
          if (id === undefined) continue;
          let list = prevPhases.get(id);
          if (!list) { list = []; prevPhases.set(id, list); }
          list.push(phase[pi]);
        }
      }

      edgeIndexById.clear();
      pulseCount = 0;
      edgeCount = 0;
      let dropped = 0;
      for (const e of edges) {
        const want = pulseCountFor(e.activity, pulsesPerEdge);
        if (want === 0) continue;
        if (pulseCount + want > MAX_PULSES || edgeCount >= MAX_PULSES) {
          dropped++;
          continue;
        }
        const ei = edgeCount++;
        edgeIndexById.set(e.id, ei);
        const go = ei * 9;
        edgeGeom[go] = e.ax; edgeGeom[go + 1] = e.ay; edgeGeom[go + 2] = e.az;
        edgeGeom[go + 3] = e.cx; edgeGeom[go + 4] = e.cy; edgeGeom[go + 5] = e.cz;
        edgeGeom[go + 6] = e.bx; edgeGeom[go + 7] = e.by; edgeGeom[go + 8] = e.bz;
        edgeActivity[ei] = Math.min(1, Math.max(0, e.activity));
        edgeBlocked[ei] = e.blocked ? 1 : 0;
        color.set(e.color);
        const carried = prevPhases.get(e.id);
        for (let k = 0; k < want; k++) {
          const pi = pulseCount++;
          pulseEdge[pi] = ei;
          // Carry a surviving pulse's phase forward; only genuinely NEW pulses
          // (e.g. activity rose → more pulses) get a fresh deterministic seed.
          phase[pi] = carried && k < carried.length ? carried[k] : phaseHash(e.id, k);
          colors[pi * 3] = color.r;
          colors[pi * 3 + 1] = color.g;
          colors[pi * 3 + 2] = color.b;
        }
      }
      geometry.setDrawRange(0, pulseCount);
      colAttr.needsUpdate = true;
      return dropped;
    },
    updateGeometry(edgeId, ax, ay, az, cx, cy, cz, bx, by, bz) {
      const ei = edgeIndexById.get(edgeId);
      if (ei == null) return;
      const go = ei * 9;
      edgeGeom[go] = ax; edgeGeom[go + 1] = ay; edgeGeom[go + 2] = az;
      edgeGeom[go + 3] = cx; edgeGeom[go + 4] = cy; edgeGeom[go + 5] = cz;
      edgeGeom[go + 6] = bx; edgeGeom[go + 7] = by; edgeGeom[go + 8] = bz;
    },
    active: () => pulseCount > 0,
    advance(dt) {
      const d = clampDelta(dt);
      clock += d;
      for (let i = 0; i < pulseCount; i++) {
        const ei = pulseEdge[i];
        const blocked = edgeBlocked[ei] === 1;
        const activity = edgeActivity[ei];
        phase[i] = advancePulse(phase[i], d, activity, blocked);
        const go = ei * 9;
        // Blocked paths stutter: a bounded sawtooth jitter on the phase makes
        // the pulse visibly struggle without ever reversing direction.
        const t = blocked
          ? Math.min(0.999, Math.max(0, phase[i] + Math.sin(clock * 7 + i) * 0.012))
          : phase[i];
        // Inline the quadratic bezier — this loop runs up to MAX_PULSES times on
        // EVERY animated frame, so allocating a {x,y,z} per pulse (the pure
        // bezierPoint) would churn ~30k short-lived objects/sec. bezierPoint stays
        // the unit-tested reference; the hot path writes straight into positions.
        const u = 1 - t;
        const w0 = u * u;
        const w1 = 2 * u * t;
        const w2 = t * t;
        positions[i * 3] = w0 * edgeGeom[go] + w1 * edgeGeom[go + 3] + w2 * edgeGeom[go + 6];
        positions[i * 3 + 1] = w0 * edgeGeom[go + 1] + w1 * edgeGeom[go + 4] + w2 * edgeGeom[go + 7];
        positions[i * 3 + 2] = w0 * edgeGeom[go + 2] + w1 * edgeGeom[go + 5] + w2 * edgeGeom[go + 8];
        energies[i] = blocked ? BLOCKED_ENERGY : 0.35 + 0.65 * activity;
      }
      posAttr.needsUpdate = true;
      energyAttr.needsUpdate = true;
    },
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
