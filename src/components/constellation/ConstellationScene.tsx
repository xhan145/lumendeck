import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ConstellationNode } from './types';
import { hashString, orbitParamsFor, orbitPosition, type OrbitParams } from './orbits';
import { buildBody, buildBroadcast, buildOrbitLine, type BodyHandle, type BroadcastHandle, type OrbitLineHandle } from './bodies';
import { createPlaybackDriver, type PlaybackDriver } from '../graph/graph3d/playbackClock';
import { createStarfield, createBackdrop, type EnvironmentHandle } from '../graph/graph3d/environment';
import { createPostPipeline, type PostPipeline } from '../graph/graph3d/postprocessing';
import { createAdaptiveQuality, clampDelta, levelRank, type AdaptiveQuality, type EffectsLevel } from '../graph/graph3d/quality';
import { createFrameStats, type FrameStatsAccumulator } from '../graph/graph3d/frameStats';
import { createMistShell, createMistSmoke, universeEmission, type MistEmitter, type MistShell, type MistSmoke } from '../graph/graph3d/mist';
import { prunePulses, pushPulse, type FlowBody, type FlowEddy, type FlowPulse } from '../graph/graph3d/flowField';

/**
 * The Open Constellation scene: the selected node as a custom-shaded central
 * planet, its children as orbiting satellites, grandchildren as subordinate
 * moons. Clicking (or keyboard-activating a label) promotes a body to the
 * center; the previous system retracts while the new one grows out of the
 * clicked satellite — selection feels like entering another orbit.
 *
 * Conventions inherited from the graph view: raw three (no R3F), try/caught
 * renderer creation degrading to the HTML fallback, a starvation-proof
 * rAF+timer loop (createPlaybackDriver) that SKIPS GPU draws while the tab is
 * hidden, wall-clock dt clamped via clampDelta, uniforms-only animation, full
 * disposal + forceContextLoss on unmount (StrictMode-safe), pixelRatio ≤ 2,
 * and an adaptive-quality governor that sheds bloom/starfield under sustained
 * slowness. Reduced motion freezes orbital time, auto-orbit, and shader drift
 * (uMotion=0) while keeping every body parked, lit, and selectable.
 */

export interface ConstellationSceneViewProps {
  root: ConstellationNode;
  centerId: string;
  onPromote: (id: string) => void;
  reducedMotion: boolean;
  quality: EffectsLevel;
  onContextFailed: () => void;
}

const PLANET_R = 1.6;
const SAT_R = 0.36;
const MOON_R = 0.13;
const MOON_ORBIT_BASE = 0.62;
const MOON_ORBIT_STEP = 0.3;
const BACKDROP_R = 240;
const CLICK_SLOP_PX = 7;
const AUTO_ORBIT_DELAY_S = 2.5;
const AUTO_ORBIT_RATE = 0.05; // rad/s — slow, comfortable idle drift

interface TierConfig {
  starCount: number;
  planetSegs: [number, number];
  satSegs: [number, number];
  moonSegs: [number, number];
  moonCap: number;
  bloom: boolean;
  dprCap: number;
  /** Max concurrent mist wisps (one Points layer; 0 = no smoke). */
  mistCount: number;
  /** Ambient nebula-bank emitter sites between orbits (rich+ only). */
  mistBanks: number;
}

const TIERS: Record<'minimal' | 'standard' | 'rich' | 'cinematic', TierConfig> = {
  minimal: { starCount: 0, planetSegs: [48, 32], satSegs: [24, 16], moonSegs: [12, 8], moonCap: 2, bloom: false, dprCap: 1.5, mistCount: 0, mistBanks: 0 },
  standard: { starCount: 900, planetSegs: [72, 48], satSegs: [32, 20], moonSegs: [14, 10], moonCap: 3, bloom: false, dprCap: 2, mistCount: 350, mistBanks: 0 },
  rich: { starCount: 1400, planetSegs: [96, 64], satSegs: [40, 24], moonSegs: [16, 10], moonCap: 4, bloom: false, dprCap: 2, mistCount: 900, mistBanks: 3 },
  cinematic: { starCount: 1400, planetSegs: [96, 64], satSegs: [40, 24], moonSegs: [16, 10], moonCap: 4, bloom: true, dprCap: 2, mistCount: 1500, mistBanks: 3 },
};

function tierFor(level: EffectsLevel): TierConfig {
  // 'off' still renders — this view IS the content — but at the minimal tier.
  if (level === 'off' || level === 'minimal') return TIERS.minimal;
  if (level === 'standard') return TIERS.standard;
  if (level === 'rich') return TIERS.rich;
  return TIERS.cinematic;
}

interface MoonEntry {
  params: OrbitParams;
  body: BodyHandle;
}

interface SatEntry {
  id: string;
  params: OrbitParams;
  group: THREE.Group;
  body: BodyHandle;
  moons: MoonEntry[];
  orbitLine: OrbitLineHandle;
  baseEnergy: number;
  /** Data-driven wisp emission (universeEmission of the node's status/strength). */
  wispRate: number;
  /** World radius used for wake kernels + emitter spread. */
  bodyRadius: number;
}

interface SystemHandle {
  group: THREE.Group;
  center: BodyHandle;
  broadcast: BroadcastHandle;
  satellites: SatEntry[];
  pickables: THREE.Mesh[];
  maxRadius: number;
  /** Data-driven mist shrouds (center + shrouded satellites), billboarded per frame. */
  shells: MistShell[];
  /** Center-body wisp emission rate. */
  centerWispRate: number;
  dispose(): void;
}

interface Retiring {
  system: SystemHandle;
  start: number;
  /** Group scale at retire time — interrupted grows shrink from HERE, not 1. */
  startScale: number;
}

interface Transition {
  start: number;
  duration: number;
  from: THREE.Vector3;
}

interface CamState {
  theta: number;
  phi: number;
  dist: number;
  targetTheta: number;
  targetPhi: number;
  targetDist: number;
}

const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

function buildSystem(node: ConstellationNode, tier: TierConfig, motion: number, now: number): SystemHandle {
  const group = new THREE.Group();
  const center = buildBody(node, {
    radius: PLANET_R,
    energy: 1,
    motion,
    widthSegments: tier.planetSegs[0],
    heightSegments: tier.planetSegs[1],
    atmosphere: true,
    atmosphereIntensity: 0.65,
  });
  group.add(center.group);

  const children = node.children ?? [];
  const satellites: SatEntry[] = [];
  const pickables: THREE.Mesh[] = [];
  const shells: MistShell[] = [];
  let maxRadius = PLANET_R * 2;

  // Mist encodes status: forming = shrouded, dormant = thin haze, active =
  // light wisps, complete = clear. The shell rides the body's own group.
  const centerProfile = universeEmission(node.status, node.strength ?? 0.5);
  if (centerProfile.shellDensity > 0) {
    const shell = createMistShell(PLANET_R, node.colors[0], node.colors[1], centerProfile);
    center.group.add(shell.mesh);
    shells.push(shell);
  }
  const centerWispRate = centerProfile.wispRate;

  children.forEach((child, i) => {
    const params = orbitParamsFor(i, children.length, child.id, child.strength ?? 0.5);
    maxRadius = Math.max(maxRadius, params.radius);
    const satGroup = new THREE.Group();
    const dormant = child.status === 'dormant';
    const baseEnergy = dormant ? 0.18 : 0.4;
    const body = buildBody(child, {
      radius: SAT_R * params.scale,
      energy: baseEnergy,
      motion,
      widthSegments: tier.satSegs[0],
      heightSegments: tier.satSegs[1],
      atmosphere: !dormant,
      atmosphereIntensity: 0.35,
    });
    satGroup.add(body.group);
    pickables.push(body.mesh);

    // Subordinate moons: a compact local orbital system for the first few
    // grandchildren — enough to read hierarchy without exploding into clutter.
    const moons: MoonEntry[] = [];
    (child.children ?? []).slice(0, tier.moonCap).forEach((grand, j) => {
      const moonParams = orbitParamsFor(j, tier.moonCap, grand.id, grand.strength ?? 0.4);
      const scaled: OrbitParams = {
        ...moonParams,
        radius: MOON_ORBIT_BASE + j * MOON_ORBIT_STEP,
        speed: moonParams.speed * 3.2, // small bodies orbit visibly faster
      };
      const moonBody = buildBody(grand, {
        radius: MOON_R,
        energy: 0.28,
        motion,
        widthSegments: tier.moonSegs[0],
        heightSegments: tier.moonSegs[1],
      });
      moonBody.mesh.userData.nodeId = grand.id;
      pickables.push(moonBody.mesh);
      satGroup.add(moonBody.group);
      moons.push({ params: scaled, body: moonBody });
    });

    const orbitLine = buildOrbitLine(params, child.colors[0]);
    group.add(orbitLine.line);
    group.add(satGroup);
    // Park each satellite at its t=0 position so reduced-motion scenes are laid
    // out correctly before the first tick.
    const p0 = orbitPosition(params, 0);
    satGroup.position.set(p0.x, p0.y, p0.z);
    const bodyRadius = SAT_R * params.scale;
    const profile = universeEmission(child.status, child.strength ?? 0.5);
    if (profile.shellDensity > 0) {
      const shell = createMistShell(bodyRadius, child.colors[0], child.colors[1], profile);
      satGroup.add(shell.mesh);
      shells.push(shell);
    }
    satellites.push({
      id: child.id,
      params,
      group: satGroup,
      body,
      moons,
      orbitLine,
      baseEnergy,
      wispRate: profile.wispRate,
      bodyRadius,
    });
  });

  const broadcast = buildBroadcast(node.colors[0], PLANET_R * 1.5, maxRadius + 3.5);
  broadcast.setTime(now);
  group.add(broadcast.mesh);

  return {
    group,
    center,
    broadcast,
    satellites,
    pickables,
    maxRadius,
    shells,
    centerWispRate,
    dispose() {
      center.dispose();
      broadcast.dispose();
      for (const shell of shells) shell.dispose();
      for (const s of satellites) {
        s.body.dispose();
        s.orbitLine.dispose();
        for (const m of s.moons) m.body.dispose();
      }
      group.parent?.remove(group);
    },
  };
}

export function ConstellationScene({ root, centerId, onPromote, reducedMotion, quality, onContextFailed }: ConstellationSceneViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const labelElsRef = useRef(new Map<string, HTMLButtonElement>());

  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    raycaster: THREE.Raycaster;
    env: EnvironmentHandle[];
    starfield: EnvironmentHandle | null;
    post: PostPipeline | null;
    driver: PlaybackDriver;
    stats: FrameStatsAccumulator;
    adaptive: AdaptiveQuality;
  } | null>(null);

  const systemRef = useRef<SystemHandle | null>(null);
  const retiringRef = useRef<Retiring | null>(null);
  const transitionRef = useRef<Transition | null>(null);
  // ---- fluid mist state ------------------------------------------------------
  const mistRef = useRef<MistSmoke | null>(null);
  const pulsesRef = useRef<readonly FlowPulse[]>([]);
  /** Pooled per-satellite wake bodies (rebuilt on system change, mutated per frame). */
  const flowBodiesRef = useRef<FlowBody[]>([]);
  /** Pooled emitters: [0]=center, then satellites, then nebula-bank sites. */
  const emittersRef = useRef<(MistEmitter & { satIndex?: number })[]>([]);
  const eddyRef = useRef<FlowEddy>({ x: 0, y: 0, z: 0, strength: 0, radius: 1.5 });
  /** Mutable flow context (structurally a FlowContext) — mutated per frame, never reallocated. */
  const flowCtxRef = useRef<{ bodies: FlowBody[]; pulses: readonly FlowPulse[]; eddy: FlowEddy | null }>({
    bodies: [],
    pulses: [],
    eddy: null,
  });
  const camRef = useRef<CamState>({ theta: 0.65, phi: 1.05, dist: 16, targetTheta: 0.65, targetPhi: 1.05, targetDist: 16 });
  const orbitTimeRef = useRef(0);
  const shaderTimeRef = useRef(0);
  const lastInteractRef = useRef(0);
  const hoveredRef = useRef<string | null>(null);
  const dirtyRef = useRef(true);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const promoteRef = useRef(onPromote);
  promoteRef.current = onPromote;

  const tier = useMemo(() => tierFor(quality), [quality]);

  const index = useMemo(() => {
    const map = new Map<string, ConstellationNode>();
    const walk = (n: ConstellationNode) => {
      map.set(n.id, n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);
    return map;
  }, [root]);

  const centerNode = index.get(centerId) ?? root;
  const satelliteNodes = useMemo(() => centerNode.children ?? [], [centerNode]);

  // ---- renderer + loop lifecycle (mount once; StrictMode-safe) -------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (err) {
      console.warn('LumenDeck: constellation WebGL unavailable, using the list view.', err);
      onContextFailed();
      return;
    }
    let ro: ResizeObserver | null = null;
    try {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dprCap));
      renderer.domElement.classList.add('constellation-gl');
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);
      const raycaster = new THREE.Raycaster();

      // Deep-space environment: opaque gradient dome (required by bloom, and
      // this view is its own world) + a distant deterministic starfield.
      const env: EnvironmentHandle[] = [];
      const backdrop = createBackdrop(BACKDROP_R, '#0b1c33', '#04101f');
      scene.add(backdrop.object);
      env.push(backdrop);
      let starfield: EnvironmentHandle | null = null;
      if (tier.starCount > 0) {
        starfield = createStarfield(tier.starCount, 90, 200, '#9fd8ff', '#c9b8ff');
        scene.add(starfield.object);
        env.push(starfield);
      }

      const post = tier.bloom ? createPostPipeline(renderer, scene, camera, { strength: 0.5, radius: 0.4, threshold: 0.8 }) : null;

      // Fluid mist smoke: one Points layer for the whole scene, persisting
      // across promotions so wisps from the old system drift out naturally.
      if (tier.mistCount > 0) {
        const mist = createMistSmoke(tier.mistCount, { size: 5, opacity: 0.15 });
        scene.add(mist.points);
        mistRef.current = mist;
      }

      const stats = createFrameStats();
      const adaptive = createAdaptiveQuality();

      const resize = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w < 2 || h < 2) return;
        renderer.setSize(w, h);
        post?.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        dirtyRef.current = true;
      };
      ro = new ResizeObserver(resize);
      ro.observe(host);
      resize();

      // ---- pointer interaction (orbit / dolly / pinch / pick / hover) ------
      const pointers = new Map<number, { x: number; y: number }>();
      let downAt: { x: number; y: number } | null = null;
      let pinchDist = 0;

      const markInteract = () => {
        lastInteractRef.current = performance.now();
        dirtyRef.current = true;
      };

      // Label chips live inside the host, so their taps bubble here. They own
      // their own click handling — the scene must never raycast "through" a
      // chip (the ray would hit whatever body happens to pass behind it).
      const isLabelTarget = (e: Event) =>
        !!(e.target as Element | null)?.closest?.('.constellation-label');

      const ndcFromEvent = (e: PointerEvent) => {
        const rect = host.getBoundingClientRect();
        return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      };

      const pickAt = (e: PointerEvent): string | null => {
        const sys = systemRef.current;
        if (!sys) return null;
        raycaster.setFromCamera(ndcFromEvent(e), camera);
        const hits = raycaster.intersectObjects(sys.pickables, false);
        const id = hits[0]?.object.userData.nodeId as string | undefined;
        return id ?? null;
      };

      const onPointerDown = (e: PointerEvent) => {
        if (isLabelTarget(e)) return; // the chip's own click handles it
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        // Capture so drags survive crossing the view edge or overlay islands
        // (the Graph3DView pattern).
        try {
          host.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort (e.g. synthetic events) */
        }
        if (pointers.size === 1) downAt = { x: e.clientX, y: e.clientY };
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        }
        markInteract();
      };

      const onPointerMove = (e: PointerEvent) => {
        const cam = camRef.current;
        if (pointers.has(e.pointerId)) {
          const prev = pointers.get(e.pointerId)!;
          const dx = e.clientX - prev.x;
          const dy = e.clientY - prev.y;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 1) {
            cam.targetTheta -= dx * 0.005;
            cam.targetPhi = Math.min(1.35, Math.max(0.3, cam.targetPhi - dy * 0.005));
          } else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinchDist > 0) {
              cam.targetDist = clampDist(cam.targetDist * (pinchDist / Math.max(d, 1)));
            }
            pinchDist = d;
          }
          markInteract();
          return;
        }
        // Hover feedback (pointer devices, no buttons held). Over a chip, the
        // chip's own CSS hover applies — clear any scene hover instead.
        const id = isLabelTarget(e) ? null : pickAt(e);
        if (id !== hoveredRef.current) {
          hoveredRef.current = id;
          host.style.cursor = id ? 'pointer' : 'grab';
          dirtyRef.current = true;
        }
      };

      const endPointer = (e: PointerEvent) => {
        if (!pointers.has(e.pointerId)) return; // e.g. a label-originated tap we ignored on down
        const wasSingle = pointers.size === 1;
        pointers.delete(e.pointerId);
        try {
          host.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        if (wasSingle && downAt) {
          const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
          if (moved < CLICK_SLOP_PX) {
            const id = pickAt(e);
            if (id && id !== centerIdRef.current) promoteRef.current(id);
          }
        }
        downAt = null;
        markInteract();
      };

      /** pointercancel / leaving mid-gesture: clear state, never pick/promote. */
      const cancelPointer = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size === 0) downAt = null;
        markInteract();
      };

      /** Pointer left the host: drop hover highlight + cursor (drag state is capture-safe). */
      const onHostLeave = () => {
        if (hoveredRef.current) {
          hoveredRef.current = null;
          host.style.cursor = 'grab';
          dirtyRef.current = true;
        }
      };

      const clampDist = (d: number) => {
        const sys = systemRef.current;
        const maxR = sys ? sys.maxRadius : 12;
        return Math.min(Math.max(d, PLANET_R * 2.4), maxR * 3.2 + 14);
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const cam = camRef.current;
        cam.targetDist = clampDist(cam.targetDist * (e.deltaY > 0 ? 1.1 : 0.9));
        markInteract();
      };

      host.addEventListener('pointerdown', onPointerDown);
      host.addEventListener('pointermove', onPointerMove);
      host.addEventListener('pointerup', endPointer);
      host.addEventListener('pointercancel', cancelPointer);
      host.addEventListener('pointerleave', onHostLeave);
      host.addEventListener('wheel', onWheel, { passive: false });
      host.style.cursor = 'grab';
      host.style.touchAction = 'none';

      // ---- the continuous loop (starvation-proof; hidden-tab draw skip) ----
      let last = performance.now();
      const tmpV3 = new THREE.Vector3();
      const tmpVel = new THREE.Vector3();
      const VEL_EPS = 0.06; // finite-difference step for orbital velocity (s)
      const tick = (): boolean => {
        const nowMs = performance.now();
        const dt = clampDelta((nowMs - last) / 1000);
        last = nowMs;
        // Hidden window: never burn GPU on steady-state animation, but DO sync
        // dirty frames once (flushScheduler semantics — the scene must present
        // a correct frame even when rAF starves or the window is occluded).
        const hidden = typeof document !== 'undefined' && document.hidden;
        if (hidden && !dirtyRef.current) return true; // stay armed, no GPU work

        const reduced = reducedRef.current;
        const sys = systemRef.current;
        const cam = camRef.current;

        // Advance clocks (frozen under reduced motion and while hidden).
        if (!reduced && !hidden) {
          orbitTimeRef.current += dt;
          shaderTimeRef.current += dt;
          // Idle auto-orbit after a grace period; manual interaction overrides.
          if (nowMs - lastInteractRef.current > AUTO_ORBIT_DELAY_S * 1000) {
            cam.targetTheta += AUTO_ORBIT_RATE * dt;
          }
        }

        // Damped camera easing toward targets.
        const ease = Math.min(1, dt * 5);
        const movedCam =
          Math.abs(cam.targetTheta - cam.theta) > 1e-4 ||
          Math.abs(cam.targetPhi - cam.phi) > 1e-4 ||
          Math.abs(cam.targetDist - cam.dist) > 1e-3;
        cam.theta += (cam.targetTheta - cam.theta) * ease;
        cam.phi += (cam.targetPhi - cam.phi) * ease;
        cam.dist += (cam.targetDist - cam.dist) * ease;
        camera.position.set(
          cam.dist * Math.sin(cam.phi) * Math.sin(cam.theta),
          cam.dist * Math.cos(cam.phi),
          cam.dist * Math.sin(cam.phi) * Math.cos(cam.theta),
        );
        camera.lookAt(0, 0, 0);

        const transition = transitionRef.current;
        const retiring = retiringRef.current;
        const animating = !reduced || transition !== null || retiring !== null || movedCam || dirtyRef.current;
        if (!animating) return true; // static reduced-motion scene: render on demand only
        dirtyRef.current = false;

        if (sys) {
          const t = orbitTimeRef.current;
          sys.center.setTime(shaderTimeRef.current);
          sys.broadcast.setTime(shaderTimeRef.current);
          for (const s of sys.satellites) {
            const p = orbitPosition(s.params, t, tmpV3);
            s.group.position.set(p.x, p.y, p.z);
            s.body.setTime(shaderTimeRef.current);
            s.body.setEnergy(hoveredRef.current === s.id ? Math.min(1, s.baseEnergy + 0.45) : s.baseEnergy);
            for (const m of s.moons) {
              const mp = orbitPosition(m.params, t, tmpV3);
              m.body.group.position.set(mp.x, mp.y, mp.z);
              m.body.setTime(shaderTimeRef.current);
            }
          }

          // ---- fluid mist: wakes, pulses, eddies, emission, shrouds ---------
          const mist = mistRef.current;
          if (mist) {
            pulsesRef.current = prunePulses(pulsesRef.current, nowMs);
            const bodies = flowBodiesRef.current;
            for (let i = 0; i < sys.satellites.length && i < bodies.length; i++) {
              const s = sys.satellites[i];
              const fb = bodies[i];
              s.group.getWorldPosition(tmpV3);
              fb.x = tmpV3.x;
              fb.y = tmpV3.y;
              fb.z = tmpV3.z;
              // Analytic orbital velocity via a small time offset (local ≈ world
              // once the grow transition settles — wakes tolerate the error).
              orbitPosition(s.params, t + VEL_EPS, tmpVel);
              fb.vx = (tmpVel.x - s.group.position.x) / VEL_EPS;
              fb.vy = (tmpVel.y - s.group.position.y) / VEL_EPS;
              fb.vz = (tmpVel.z - s.group.position.z) / VEL_EPS;
              fb.radius = s.bodyRadius * 2.4;
            }
            // Emitters ride their satellites; the hover eddy stirs locally.
            for (const e of emittersRef.current) {
              if (e.satIndex != null) {
                const s = sys.satellites[e.satIndex];
                if (s) {
                  s.group.getWorldPosition(tmpV3);
                  e.x = tmpV3.x;
                  e.y = tmpV3.y;
                  e.z = tmpV3.z;
                }
              }
            }
            const ctx = flowCtxRef.current;
            ctx.pulses = pulsesRef.current;
            const hoveredSat = hoveredRef.current ? sys.satellites.find((x) => x.id === hoveredRef.current) : undefined;
            if (hoveredSat) {
              hoveredSat.group.getWorldPosition(tmpV3);
              const eddy = eddyRef.current;
              eddy.x = tmpV3.x;
              eddy.y = tmpV3.y;
              eddy.z = tmpV3.z;
              eddy.strength = 1.6;
              eddy.radius = hoveredSat.bodyRadius * 3;
              ctx.eddy = eddy;
            } else {
              ctx.eddy = null;
            }
            // Reduced motion: dt=0 freezes spawning + advection; densities stay.
            mist.advance(reduced ? 0 : dt, shaderTimeRef.current, nowMs, ctx, emittersRef.current);
          }
          // Mist shrouds billboard toward the camera and churn on shader time.
          for (const shell of sys.shells) {
            shell.setTime(shaderTimeRef.current);
            shell.mesh.quaternion.copy(camera.quaternion);
          }

          // Selection transition: the new system grows out of the clicked
          // satellite's position while the old one retracts and dims.
          if (transition) {
            const p = Math.min(1, (nowMs - transition.start) / transition.duration);
            const e = easeOutCubic(p);
            sys.group.position.lerpVectors(transition.from, ORIGIN, e);
            const scale = 0.3 + 0.7 * e;
            sys.group.scale.setScalar(scale);
            if (p >= 1) {
              sys.group.position.set(0, 0, 0);
              sys.group.scale.setScalar(1);
              transitionRef.current = null;
            }
          }
        }
        if (retiring) {
          const p = Math.min(1, (nowMs - retiring.start) / 700);
          const e = easeOutCubic(p);
          // Scale from the CAPTURED value at retire time — an interrupted
          // half-grown system must shrink from where it was, never pop to 1.
          retiring.system.group.scale.setScalar(retiring.startScale * (1 - 0.5 * e));
          retiring.system.center.setEnergy(1 - e);
          for (const s of retiring.system.satellites) s.body.setEnergy(s.baseEnergy * (1 - e));
          for (const shell of retiring.system.shells) shell.mesh.quaternion.copy(camera.quaternion);
          if (p >= 1) {
            retiring.system.dispose();
            retiringRef.current = null;
          }
        }

        // Screen-projected satellite labels (real focusable DOM buttons).
        if (sys) {
          const rectW = host.clientWidth;
          const rectH = host.clientHeight;
          for (const s of sys.satellites) {
            const el = labelElsRef.current.get(s.id);
            if (!el) continue;
            s.group.getWorldPosition(tmpV3);
            tmpV3.y += SAT_R * s.params.scale + 0.32;
            tmpV3.project(camera);
            const visible = tmpV3.z < 1 && Math.abs(tmpV3.x) < 1.05 && Math.abs(tmpV3.y) < 1.05;
            if (!visible) {
              // visibility (not just opacity) removes the chip from the tab
              // order + accessibility tree — no focusable invisible buttons.
              el.style.opacity = '0';
              el.style.visibility = 'hidden';
              el.style.pointerEvents = 'none';
              continue;
            }
            const x = ((tmpV3.x + 1) / 2) * rectW;
            const y = ((1 - tmpV3.y) / 2) * rectH;
            el.style.opacity = '1';
            el.style.visibility = 'visible';
            el.style.pointerEvents = 'auto';
            el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
            el.dataset.hovered = hoveredRef.current === s.id ? 'true' : 'false';
          }
        }

        // Render + instrumentation + adaptive shedding. The governor is fed the
        // RENDER-TO-RENDER cadence (GPU-bound slowness widens the gap between
        // frames; render() itself returns after command submission), exactly
        // like Graph3DView's recordFrame — never CPU tick duration, and never
        // hidden frames (the ~30ms timer cadence would read as sustained
        // slowness). quality.ts's maxSampleMs gap filter absorbs idle sleeps.
        if (post && !postDisabled) post.render();
        else renderer.render(scene, camera);
        if (hidden) {
          lastRenderTs = 0; // hidden dirty-sync frames must not pollute the cadence
          return true;
        }
        const after = performance.now();
        if (lastRenderTs > 0) {
          const delta = after - lastRenderTs;
          stats.sample(delta);
          if (adaptive.feed(delta, after)) {
            const cap = adaptive.cap();
            if (starfield) starfield.object.visible = levelRank(cap) >= levelRank('rich');
            postDisabled = levelRank(cap) < levelRank('cinematic');
          }
        }
        lastRenderTs = after;
        return true;
      };

      let postDisabled = false;
      let lastRenderTs = 0;
      const driver = createPlaybackDriver(tick, {
        requestFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (id) => cancelAnimationFrame(id),
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (id) => window.clearTimeout(id),
      });

      ctxRef.current = { renderer, scene, camera, raycaster, env, starfield, post, driver, stats, adaptive };

      return () => {
        driver.stop();
        ro?.disconnect();
        host.removeEventListener('pointerdown', onPointerDown);
        host.removeEventListener('pointermove', onPointerMove);
        host.removeEventListener('pointerup', endPointer);
        host.removeEventListener('pointercancel', cancelPointer);
        host.removeEventListener('pointerleave', onHostLeave);
        host.removeEventListener('wheel', onWheel);
        retiringRef.current?.system.dispose();
        retiringRef.current = null;
        systemRef.current?.dispose();
        systemRef.current = null;
        transitionRef.current = null; // a stale transition must never animate the NEXT mount's system
        mistRef.current?.dispose();
        mistRef.current = null;
        pulsesRef.current = [];
        for (const e of env) e.dispose();
        post?.dispose();
        renderer.dispose();
        renderer.forceContextLoss(); // context caps: never wait for GC
        renderer.domElement.remove();
        ctxRef.current = null;
      };
    } catch (err) {
      console.warn('LumenDeck: constellation scene setup failed, using the list view.', err);
      ro?.disconnect();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      onContextFailed();
      return;
    }
    // Mount-once by design; tier changes rebuild via the system effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier]);

  // The pick handler needs the live centerId without rebinding listeners.
  const centerIdRef = useRef(centerId);
  centerIdRef.current = centerId;

  // ---- (re)build the orbital system when the selected node changes ---------
  const builtCenterRef = useRef<string | null>(null);
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const node = index.get(centerId) ?? root;
    const reduced = reducedRef.current;
    // A store-driven root rebuild with an UNCHANGED center is a data refresh,
    // not a promotion: swap the system in place — no retiring choreography, no
    // grow transition, no camera reframe (the user's zoom is theirs).
    const isRefresh = builtCenterRef.current === centerId && systemRef.current !== null;
    builtCenterRef.current = centerId;

    // Where should the new system grow from? The promoted body's current world
    // position — satellite or moon — if it was on screen (else the origin).
    const from = new THREE.Vector3(0, 0, 0);
    const old = systemRef.current;
    if (old && !isRefresh) {
      const promoted = old.satellites.find((s) => s.id === centerId);
      if (promoted) {
        promoted.group.getWorldPosition(from);
      } else {
        // Deep promotion: the clicked body may be a MOON of a satellite.
        outer: for (const s of old.satellites) {
          for (const m of s.moons) {
            if (m.body.mesh.userData.nodeId === centerId) {
              m.body.group.getWorldPosition(from);
              break outer;
            }
          }
        }
      }
      // An in-flight retiree is disposed immediately — transitions stay
      // interruptible without compounding.
      retiringRef.current?.system.dispose();
      retiringRef.current = { system: old, start: performance.now(), startScale: old.group.scale.x };
      // The promotion sends a pressure ring through the mist from the clicked body.
      pulsesRef.current = pushPulse(pulsesRef.current, { x: from.x, y: from.y, z: from.z, t0: performance.now(), amp: 5 });
    } else if (old && isRefresh) {
      old.dispose();
      retiringRef.current?.system.dispose();
      retiringRef.current = null;
      transitionRef.current = null;
    }

    const sys = buildSystem(node, tier, reduced ? 0 : 1, shaderTimeRef.current);
    ctx.scene.add(sys.group);
    systemRef.current = sys;

    // Rebuild the fluid pools for the new system (allocation happens HERE, not
    // per frame): wake bodies per satellite + emitters (center, satellites,
    // deterministic nebula-bank sites at rich+).
    flowBodiesRef.current = sys.satellites.map(() => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, radius: 1 }));
    flowCtxRef.current.bodies = flowBodiesRef.current;
    const emitters: (MistEmitter & { satIndex?: number })[] = [
      { x: 0, y: 0, z: 0, radius: PLANET_R * 1.5, rate: sys.centerWispRate, color: new THREE.Color(node.colors[0]) },
    ];
    sys.satellites.forEach((s, i) => {
      const childColors = index.get(s.id)?.colors ?? node.colors;
      emitters.push({ x: 0, y: 0, z: 0, radius: s.bodyRadius * 2.2, rate: s.wispRate, color: new THREE.Color(childColors[0]), satIndex: i });
    });
    for (let k = 0; k < tier.mistBanks; k++) {
      const a = ((hashString(`${node.id}:bank:${k}`) % 1000) / 1000) * Math.PI * 2;
      const r = sys.maxRadius * (1.12 + 0.18 * k);
      emitters.push({ x: Math.cos(a) * r, y: (k - 1) * 1.4, z: Math.sin(a) * r, radius: 2.6, rate: 2.2, color: new THREE.Color(node.colors[1]) });
    }
    emittersRef.current = emitters;

    if (old && !isRefresh) {
      sys.group.position.copy(from);
      sys.group.scale.setScalar(0.3);
      transitionRef.current = { start: performance.now(), duration: reduced ? 220 : 900, from };
      // Frame the new system: out for wide systems, in for tight ones.
      const cam = camRef.current;
      cam.targetDist = Math.min(Math.max(sys.maxRadius * 1.9 + 4, 9), 46);
    } else if (!old) {
      const cam = camRef.current;
      cam.targetDist = Math.min(Math.max(sys.maxRadius * 1.9 + 4, 9), 46);
    }
    dirtyRef.current = true;

    return () => {
      // Unmount-only cleanup: the NEXT run of this effect handles handoff; if
      // the component is going away entirely, the mount effect disposes all.
    };
  }, [centerId, index, root, tier]);

  // Reduced-motion flips propagate to live materials without a rebuild.
  useEffect(() => {
    const sys = systemRef.current;
    if (!sys) return;
    const motion = reducedMotion ? 0 : 1;
    sys.center.setMotion(motion);
    sys.broadcast.setMotion(motion);
    for (const s of sys.satellites) {
      s.body.setMotion(motion);
      for (const m of s.moons) m.body.setMotion(motion);
    }
    dirtyRef.current = true;
  }, [reducedMotion]);

  // ---- satellite labels: real buttons, positioned by the loop --------------
  const registerLabel = (id: string) => (el: HTMLButtonElement | null) => {
    if (el) labelElsRef.current.set(id, el);
    else labelElsRef.current.delete(id);
  };

  return (
    <div ref={hostRef} className="constellation-canvas-host">
      <div ref={labelLayerRef} className="constellation-labels" aria-hidden={false}>
        {satelliteNodes.map((child) => (
          <button
            key={`${centerId}:${child.id}`}
            ref={registerLabel(child.id)}
            type="button"
            className="constellation-label"
            style={{ opacity: 0, visibility: 'hidden' }}
            onClick={() => onPromote(child.id)}
            title={child.description || child.label}
          >
            {child.label}
            {(child.children?.length ?? 0) > 0 ? <span className="constellation-label-count"> · {child.children!.length}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

const ORIGIN = new THREE.Vector3(0, 0, 0);
