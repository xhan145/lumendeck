import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { CAPSULES, CAPSULE_CATEGORY_LABELS, CAPSULE_KINDS } from '../../core/capsules';
import { canConnect } from '../../core/workflow';
import type { CapsuleCategory, CapsuleKind, SocketDef, SocketType, WorkflowNode } from '../../core/types';
import { useStudio } from '../../state/store';
import { CapsuleIcon, Icon } from '../icons';
import { CollapsiblePalette } from './CollapsiblePalette';
import { GraphNode } from './GraphNode';
import { OrbChip } from './OrbChip';
import { GhostChip } from './GhostChip';
import { nodeSummary } from './nodeSummary';
import { NODE_WIDTH, socketColor, socketPoint, type Point } from './wires';
import {
  LIFT,
  ORB_RADIUS,
  canvasFromWorld,
  orbSurfacePoint,
  orbWorldCenter,
  pointerRayToPlane,
  socketWorldPoint,
  worldFromCanvas,
  zFromNode,
  type Vec3,
  type WorldPoint,
} from './graph3d/projection';
import { gradientStops, primaryParamId, primaryWeight, weightT } from './graph3d/orbWeight';
import {
  angleToValue,
  clamp,
  fieldPosToWorld,
  hitRingBand,
  nudgeFieldPos,
  pointerAngle,
  worldToFieldPos,
} from './graph3d/ghostGizmo';
import { createFlushScheduler, type FlushScheduler } from './graph3d/flushScheduler';
import { advancePlayback, createPlaybackDriver, type PlaybackDriver } from './graph3d/playbackClock';
import { createFrameStats, type FrameStatsAccumulator } from './graph3d/frameStats';
import { createFabric, packWells, MAX_WELLS, FABRIC_EXTENT, type FabricHandle } from './graph3d/fabric';
import { nodeAnomaly, makeAnomalyRing } from './graph3d/anomaly';
import { settleShouldRun } from './graph3d/settle';
import { createFlashLimiter, type FlashLimiter } from './graph3d/flashLimiter';
import { createParticleField, type ParticleField } from './graph3d/particles';
import {
  createAdaptiveQuality,
  featuresFor,
  minLevel,
  motionPolicy,
  type AdaptiveQuality,
  type EffectsLevel,
} from './graph3d/quality';
import { createEnergyFlow, type EnergyFlow, type FlowEdge } from './graph3d/energyFlow';
import { createStarfield, createBackdrop, type EnvironmentHandle } from './graph3d/environment';
import { createPostPipeline, type PostPipeline } from './graph3d/postprocessing';
import { sampleClip, trackKey } from '../../core/motion/interpolate';
import { motionOffset } from '../../core/motion/orbMotion';
import type { MotionClip } from '../../core/motion/types';
import { MotionTimeline } from '../motion/MotionTimeline';
import { EvolvePanel } from '../evolve/EvolvePanel';
import {
  buildNeonGrid,
  disposeObject3D,
  makeOrbGeometry,
  makeOrbMaterial,
  makeOrbRing,
  makeWireLine,
  resolveCssColor,
  setOrbEmissive,
  setOrbTime,
  updateOrbMaterial,
  updateWireLine,
  wireControl,
} from './graph3d/scene';
import { emissiveFor } from '../../state/nodeMeta';
import { estimateFamilyFromModelId, type ControlNetFamily } from '../../core/controlnet';
import { fieldProfile, type FieldProfile } from '../../core/field/fieldProfile';
import { applyField } from '../../core/field/applyField';
import type { Ghost } from '../../state/store';
import { readAudioFrequency } from '../../state/store';
import { computeBands, scaleBands } from '../../core/audio/bands';
import { applyAudio, type AudioReaction } from '../../core/audio/mapping';
import { AudioPanel } from '../audio/AudioPanel';
import { FieldPresetsPanel } from '../field/FieldPresetsPanel';
import { StreamingPreview } from '../field/StreamingPreview';
import { createSettleDebouncer, normalizePos, type SettleDebouncer } from '../field/fieldPreview';

interface Props {
  /** Called when the WebGL context cannot be created (workspace falls back to 2D). */
  onContextFailed?: () => void;
}

interface WireDraft {
  fromNode: string;
  fromSocket: SocketDef;
  /** Cursor position in WORKFLOW coords (projected onto the source node's plane). */
  cursor: Point;
}

interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
  /** Fixed drag plane (captured at pointer-down) so the node tracks the ray stably. */
  planeZ: number;
}

interface CamState {
  tx: number;
  ty: number;
  tz: number;
  theta: number;
  phi: number;
  dist: number;
}

interface ThreeCtx {
  renderer: THREE.WebGLRenderer;
  cssRenderer: CSS3DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  wireGroup: THREE.Group;
  orbGroup: THREE.Group;
  /** Translucent ghost-controller orbs + axis guides (v0.16 overlay). */
  ghostGroup: THREE.Group;
  /** Saved-anchor markers (v0.16 overlay). */
  anchorGroup: THREE.Group;
  /** Shared smooth-shaded sphere geometry for every orb (disposed on unmount). */
  orbGeometry: THREE.SphereGeometry;
  nodeObjects: Map<string, CSS3DObject>;
  draftLine: THREE.Line | null;
  raycaster: THREE.Raycaster;
}

/** Per-node orb scene entry (sphere + value ring), keyed by node id. */
interface OrbEntry {
  group: THREE.Group;
  material: THREE.ShaderMaterial;
  ring: THREE.Mesh | null;
  /** Normalized weight the current ring was built for (-1 = no ring). */
  ringT: number;
  /** Gradient+accent signature of the current material tint (skip no-op updates). */
  tintKey: string;
  /** Palette-breaking health outline ring (constellation anomaly encoding). */
  anomalyRing: THREE.Mesh | null;
  /** Anomaly level the current ring was built for ('' = none) — skip no-op rebuilds. */
  anomalyKey: string;
}

/** Gradient stops for weightless kinds: a neutral slate orb. */
const NEUTRAL_ORB_STOPS: [string, string, string] = ['#42526b', '#5c6d87', '#7b8ca6'];

/** Per-ghost scene entry: a translucent orb group + labeled axis guides, keyed by ghost id. */
interface GhostEntry {
  group: THREE.Group;
  material: THREE.ShaderMaterial;
  /** Field profile the axis guides were built for (rebuilt when it changes). */
  profileKey: string;
}

/** Per-anchor scene entry: a small clickable marker, keyed by anchor id. */
interface AnchorEntry {
  group: THREE.Group;
  mesh: THREE.Mesh;
}

/** Live ring-dial drag: which node's primary value the pointer is turning. */
interface RingDrag {
  nodeId: string;
  param: string;
  min: number;
  max: number;
  /** Orb center in screen px (the dial pivot), captured at pointer-down. */
  cx: number;
  cy: number;
}

/** Live ghost drag: the ghost being flown through the field. */
interface GhostDrag {
  id: string;
  nodeId: string;
  /** Fixed ground-plane z (world) the pointer ray intersects for X/Z. */
  planeZ: number;
  /** True while Shift is held: the drag sets Y (height) instead of X/Z. */
  shift: boolean;
  /** Screen y at the moment Shift-drag began (for the height delta). */
  shiftStartY: number;
  /** Field Y at the moment Shift-drag began. */
  shiftStartFieldY: number;
}

/** Translucent ghost orb opacity (spec: ~0.45). */
const GHOST_OPACITY = 0.45;
/** Pointer band (px) that counts as grabbing the equatorial ring dial. */
const RING_BAND = { inner: 12, outer: 16 };
/** Screen px of vertical Shift-drag that spans the full field Y axis. */
const GHOST_SHIFT_PX_PER_AXIS = 320;
/** Quiet period (ms) a ghost drag must settle before a streaming preview fires. */
const PREVIEW_SETTLE_MS = 150;
/** Anchor marker radius (world units). */
const ANCHOR_RADIUS = 14;

/**
 * Every socket type any capsule can expose — used to pre-resolve ALL wire
 * colors to concrete hex once per mount, so the render/sync path never hands
 * THREE.Color a raw `var()` string and never touches getComputedStyle again.
 */
const ALL_SOCKET_TYPES: SocketType[] = Array.from(
  new Set(Object.values(CAPSULES).flatMap((def) => [...def.inputs, ...def.outputs].map((s) => s.type))),
);

const DEFAULT_CAM: Omit<CamState, 'tx' | 'ty' | 'tz'> = { theta: 0, phi: 1.22, dist: 1500 };
const PHI_MIN = 0.17;
const PHI_MAX = 1.4;
const DIST_MIN = 420;
const DIST_MAX = 4200;
const ORBIT_SPEED = 0.005;
const PAN_SPEED = 0.0016;
/** Pointer travel (px) below which a background press counts as a click. */
const CLICK_SLOP = 5;

/**
 * Cap on how often the playback loop writes transport.t back to the store. The
 * authoritative playhead lives in the loop's wall-clock ref and drives orbs +
 * the scrubber every frame; the store write only feeds the coarse UI time
 * readout, so a low rate is plenty and avoids a 30Hz write storm that would (a)
 * churn the store and (b) starve the trailing-debounce persistence save.
 */
const TRANSPORT_WRITE_HZ = 6;

const CATEGORY_FILTERS: ('all' | CapsuleCategory)[] = [
  'all',
  'core',
  'loaders',
  'conditioning',
  'latent',
  'control',
  'image',
  'mask',
  'sampling',
  'video',
  'utility',
  'output',
];

/** True when the event started on empty 3D space (not a node card or HUD chrome). */
function isBackgroundTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !el.closest('.gnode, .orb-chip, .ghost-chip, .collapsible-palette, .graph-toolbar, .graph-hint, .graph-mode-toggle, .graph3d-note, .graph3d-ghost-note, .motion-panel');
}

export function Graph3DView({ onContextFailed }: Props) {
  const workflow = useStudio((s) => s.workflow);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const graph3dStyle = useStudio((s) => s.appSettings.graph3dStyle ?? 'orbs');
  const graph3dEffects = useStudio((s) => s.appSettings.graph3dEffects ?? 'off');
  const showDiagnostics = useStudio((s) => s.appSettings.showDiagnostics);
  // Health drives the anomaly outline encoding. Recomputed on every workflow
  // commit (a new array), so this coincides with the workflow subscription — no
  // extra re-render churn — but keeps the anomaly rings live on shelf changes too.
  const health = useStudio((s) => s.health);
  // Per-node activity metadata drives the luminosity glow. Reference changes on
  // every touch (like health) so the reconcile re-snapshots emissive on edits.
  const nodeMeta = useStudio((s) => s.nodeMeta);
  const updateAppSettings = useStudio((s) => s.updateAppSettings);
  const selectNode = useStudio((s) => s.selectNode);
  const moveNodeTo = useStudio((s) => s.moveNodeTo);
  const connectSockets = useStudio((s) => s.connectSockets);
  const disconnectEdge = useStudio((s) => s.disconnectEdge);
  const addCapsule = useStudio((s) => s.addCapsule);
  const duplicateCapsule = useStudio((s) => s.duplicateCapsule);
  const autoLayoutGraph = useStudio((s) => s.autoLayoutGraph);
  const removeCapsule = useStudio((s) => s.removeCapsule);
  // Motion playback: subscribe only to the play flag (a boolean) so this heavy
  // 3D view re-renders when playback starts/stops — never per animated frame.
  // The loop reads the live clip/transport/workflow via useStudio.getState().
  const transportPlaying = useStudio((s) => s.transport.playing);
  // Subscribe to the active clip id so the playback effect tears down + re-arms
  // when the clip changes or disappears (e.g. the active clip is deleted mid-play).
  const activeClipId = useStudio((s) => s.motion.activeClipId);
  // Audio reactivity: subscribe only to the running flag so the reactive tick
  // effect arms/disarms when audio starts/stops. The loop reads the live
  // mapping/sensitivity + engine frames via useStudio.getState() each frame.
  const audioRunning = useStudio((s) => s.audio.running);

  // ---- Render-Space Ghost Controller (v0.16.0) ----------------------------
  // The field slice + its actions land in parallel (src/state); this half only
  // reads the ghosts/anchors and calls the actions per the shared contract.
  const ghosts = useStudio((s) => s.field.ghosts);
  const anchors = useStudio((s) => s.field.anchors);
  const spawnGhost = useStudio((s) => s.spawnGhost);
  const moveGhost = useStudio((s) => s.moveGhost);
  const setGhostIntensity = useStudio((s) => s.setGhostIntensity);
  const pinGhost = useStudio((s) => s.pinGhost);
  const collapseGhost = useStudio((s) => s.collapseGhost);
  const saveAnchor = useStudio((s) => s.saveAnchor);
  const restoreAnchor = useStudio((s) => s.restoreAnchor);
  const deleteAnchor = useStudio((s) => s.deleteAnchor);
  const startGhostRecording = useStudio((s) => s.startGhostRecording);
  const stopGhostRecording = useStudio((s) => s.stopGhostRecording);
  const updateParam = useStudio((s) => s.updateParam);

  // ---- Field-preset streaming preview (v0.19) -----------------------------
  // Subscribe to the streaming toggle so the settle-debouncer is cancelled the
  // moment streaming is turned off. The hot drag path reads the live field slice
  // via useStudio.getState() (freshest, no stale closure); the store owns the
  // supersede token + the actual low-res render (runFieldPreview).
  const streamingEnabled = useStudio((s) => s.field.streamingEnabled);

  const viewportRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<ThreeCtx | null>(null);
  const flushRef = useRef<FlushScheduler | null>(null);
  const camRef = useRef<CamState>({ tx: 0, ty: 0, tz: 0, ...DEFAULT_CAM });
  const anchorsRef = useRef(new Map<string, HTMLDivElement>());
  const orbsRef = useRef(new Map<string, OrbEntry>());
  const colorCacheRef = useRef(new Map<SocketType, string>());
  const accentCacheRef = useRef(new Map<CapsuleKind, string>());
  const dragRef = useRef<DragState | null>(null);
  const interactionRef = useRef<{ mode: 'orbit' | 'pan'; x: number; y: number; moved: number } | null>(null);
  // Ghost/anchor scene entries (reconciled like orbs; disposed on unmount).
  const ghostsSceneRef = useRef(new Map<string, GhostEntry>());
  const anchorsSceneRef = useRef(new Map<string, AnchorEntry>());
  /** Zero-size CSS3D anchors hosting each ghost's DOM chip (value/toolbar/slider). */
  const ghostChipAnchorsRef = useRef(new Map<string, HTMLDivElement>());
  const ringDragRef = useRef<RingDrag | null>(null);
  const ghostDragRef = useRef<GhostDrag | null>(null);
  /**
   * Trailing settle-debounce for the streaming preview: each ghost-drag position
   * is pushed here; when the drag settles ~150ms one low-res preview fires. The
   * ref persists across renders and is cancelled on drag-end / streaming-off /
   * unmount so no stray render is queued and no timer leaks.
   */
  const previewDebouncerRef = useRef<SettleDebouncer | null>(null);
  if (!previewDebouncerRef.current) {
    previewDebouncerRef.current = createSettleDebouncer(PREVIEW_SETTLE_MS);
  }
  const onContextFailedRef = useRef(onContextFailed);
  onContextFailedRef.current = onContextFailed;
  /** The starvation-proof playback driver (rAF + timer fallback); null when not playing. */
  const playbackDriver = useRef<PlaybackDriver | null>(null);
  // ---- constellation GPU overhaul (First Slice: gravity fabric) ------------
  /** Pure frame-time instrument, fed at every render site; published to the overlay at ~2Hz. */
  const frameStatsRef = useRef<FrameStatsAccumulator | null>(null);
  if (!frameStatsRef.current) frameStatsRef.current = createFrameStats();
  const lastFrameTsRef = useRef(0);
  const lastStatsPublishRef = useRef(0);
  const statsElRef = useRef<HTMLDivElement | null>(null);
  /** The gravity-fabric layer (own Group); null when the effects flag is off. */
  const fabricRef = useRef<FabricHandle | null>(null);
  /** True once we've warned about >MAX_WELLS nodes (warn once, not per reconcile). */
  const clampWarnedRef = useRef(false);
  /** Short-lived rAF+timer driver animating idle-time ripples until they settle. */
  const settleDriverRef = useRef<PlaybackDriver | null>(null);
  /** Shared WCAG flash limiter across all ripple sources (≤3 onsets / rolling sec). */
  const flashLimiterRef = useRef<FlashLimiter | null>(null);
  if (!flashLimiterRef.current) flashLimiterRef.current = createFlashLimiter();
  /** Node ids that carried a health ERROR at the last commit (new-error diffing). */
  const prevErrorNodesRef = useRef<Set<string>>(new Set());
  /** Seed the error set on the first health pass so pre-existing errors don't burst. */
  const healthSeededRef = useRef(false);
  /** Ambient gravity-dust field (standard tier and up); existence == "particles active". */
  const particleFieldRef = useRef<ParticleField | null>(null);
  /** Directed workflow-energy pulses (standard tier and up, motion allowing). */
  const energyFlowRef = useRef<EnergyFlow | null>(null);
  /** Warn once when the pulse capacity drops edges (no silent caps). */
  const flowDropWarnedRef = useRef(false);
  /** Distant starfield (rich+) and opaque cinematic backdrop dome. */
  const starfieldRef = useRef<EnvironmentHandle | null>(null);
  const backdropRef = useRef<EnvironmentHandle | null>(null);
  /** Bloom/tone-mapping composer (cinematic tier only); null renders direct. */
  const postRef = useRef<PostPipeline | null>(null);
  /** Measured-performance ceiling for the expensive ambient layers. */
  const adaptiveRef = useRef<AdaptiveQuality | null>(null);
  if (!adaptiveRef.current) adaptiveRef.current = createAdaptiveQuality();

  const [ready, setReady] = useState(false);
  /**
   * The adaptive cap lives in React state so tier transitions re-run the layer
   * lifecycles. Transitions are rare by construction (hysteresis + slow
   * recovery in quality.ts), so this never becomes a per-frame state churn.
   */
  const [adaptiveCap, setAdaptiveCap] = useState<EffectsLevel>(adaptiveRef.current.cap());
  /**
   * Effective level for the EXPENSIVE layers (particles, pulses, bloom,
   * starfield, fabric density/waves): user intent capped by measured frame
   * performance. DATA encodings (wells, anomaly rings, luminosity) key off the
   * raw user setting — degradation must never remove information.
   */
  const effectsLevel = minLevel(graph3dEffects as EffectsLevel, adaptiveCap);
  const effectsLevelRef = useRef(effectsLevel);
  effectsLevelRef.current = effectsLevel;
  const [wire, setWire] = useState<WireDraft | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | CapsuleCategory>('all');
  /** Motion Timeline overlay: collapsed by default so it never obscures the graph. */
  const [motionPanelOpen, setMotionPanelOpen] = useState(false);

  /** Detached portal containers — one live DOM card per node, keyed and stable. */
  const getAnchor = (id: string): HTMLDivElement => {
    let el = anchorsRef.current.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'graph3d-node-anchor';
      anchorsRef.current.set(id, el);
    }
    return el;
  };

  /**
   * Dirty-flag render: one coalesced flush per invalidation, fully idle when
   * nothing changes. The scheduler arms a rAF (fast path) PLUS a short timer
   * fallback so the scene — including the CSS3D card/chip DOM — still syncs
   * with the store when the tab is hidden or the browser only produces frames
   * on demand (headless), where rAF alone would starve forever.
   */
  /**
   * Sample one rendered frame into the pure frameStats accumulator and, at ~2Hz,
   * publish a one-line readout to the diagnostics overlay imperatively (no React
   * re-render). Called right after every renderer.render pair (flush + loops).
   * Closes over refs only, so it is safe to reference inside the flush body below.
   */
  const recordFrame = useCallback(() => {
    const t = threeRef.current;
    const fs = frameStatsRef.current;
    if (!t || !fs) return;
    const now = performance.now();
    const prev = lastFrameTsRef.current;
    lastFrameTsRef.current = now;
    if (prev > 0) {
      const dt = now - prev;
      fs.sample(dt);
      // Adaptive quality: sustained slow frames lower the expensive-layer cap
      // one hysteresis-guarded step at a time; recovery is deliberately slow.
      // (Idle dirty-flag gaps are ignored inside the controller.) Hidden-tab
      // frames are NEVER fed: the starvation-proof playback driver ticks at a
      // deliberate ~30ms there, which would read as sustained slowness and
      // wrongly strip quality while the user isn't even looking.
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (!hidden && adaptiveRef.current?.feed(dt, now)) setAdaptiveCap(adaptiveRef.current.cap());
    }
    fs.setDrawCalls(t.renderer.info.render.calls);
    if (statsElRef.current && now - lastStatsPublishRef.current > 500) {
      lastStatsPublishRef.current = now;
      const s = fs.read();
      const cap = adaptiveRef.current?.cap();
      const tier = `${effectsLevelRef.current}${cap && cap !== 'cinematic' ? ' (auto-capped)' : ''}`;
      statsElRef.current.textContent = `${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(1)}ms · worst ${s.worstMs.toFixed(1)}ms · ${s.drawCalls} draws · ${tier}`;
    }
  }, []);

  /**
   * Render ONE frame of the WebGL scene + the CSS3D DOM layer. The single
   * chokepoint every loop and flush uses: when the cinematic post pipeline is
   * live it composes the high-threshold bloom; otherwise it is the plain
   * direct render. CSS3D always renders after (the DOM layer sits above the
   * canvas and is never post-processed — controls stay crisp by construction).
   */
  const renderScene = useCallback(() => {
    const t = threeRef.current;
    if (!t) return;
    if (postRef.current) postRef.current.render();
    else t.renderer.render(t.scene, t.camera);
    t.cssRenderer.render(t.scene, t.camera);
  }, []);

  if (!flushRef.current) {
    flushRef.current = createFlushScheduler(
      () => {
        if (!threeRef.current) return;
        renderScene();
        recordFrame();
      },
      {
        requestFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (id) => cancelAnimationFrame(id),
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (id) => window.clearTimeout(id),
      },
    );
  }
  const requestRender = useCallback(() => {
    flushRef.current?.request();
  }, []);

  /**
   * Fade every orb's luminosity glow from live activity recency. Called each frame
   * by the animating loops so the glow decays smoothly while anything animates; the
   * orb-reconcile snapshots it otherwise (idle-safe). MUST use Date.now() — the
   * store stamps lastActiveAt with Date.now(), and mixing in performance.now()
   * would make age hugely negative and pin every orb to full glow. Forces 0 when
   * the effects flag is off so flag-off playback/audio renders identically to before.
   */
  const updateEmissive = useCallback(() => {
    const s = useStudio.getState();
    const off = (s.appSettings.graph3dEffects ?? 'off') === 'off';
    const now = Date.now();
    // Shimmer clock only advances here — i.e. only while some loop is already
    // animating — so an idle scene's orb surfaces stay perfectly still.
    const tSec = performance.now() / 1000;
    const meta = s.nodeMeta;
    for (const [id, entry] of orbsRef.current) {
      setOrbTime(entry.material, tSec);
      setOrbEmissive(entry.material, off ? 0 : emissiveFor(meta[id], now));
    }
  }, []);

  /**
   * Ensure the idle animator is running while there is idle-time animation to do —
   * live ripples decaying and/or ambient gravity dust (rich tier). Idempotent
   * (no-op if already running). It NEVER starts while playback/audio owns the
   * frame — that mutual exclusion (graph3d/settle.ts) is what keeps "exactly one
   * render per frame". While the tab is hidden it stays armed but skips the draw
   * (no GPU burn), and it self-stops once nothing needs animating, restoring the
   * dirty-flag idle sleep.
   */
  const wakeSettle = useCallback(() => {
    if (settleDriverRef.current?.running()) return;
    const s = useStudio.getState();
    const decayActive =
      particleFieldRef.current != null ||
      (energyFlowRef.current?.active() ?? false) ||
      (fabricRef.current?.ripplesAlive(performance.now()) ?? false);
    if (!settleShouldRun({ decayActive, playing: s.transport.playing, audioRunning: s.audio.running })) return;
    let last = performance.now();
    settleDriverRef.current = createPlaybackDriver(
      () => {
        const t = threeRef.current;
        if (!t) return false;
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        const pf = particleFieldRef.current;
        const flow = energyFlowRef.current;
        const flowActive = flow?.active() ?? false;
        const fab = fabricRef.current;
        // Hidden tab: stay armed only if something still needs animating, but skip
        // the GPU draw entirely (R4 — no rendering into an invisible window).
        if (typeof document !== 'undefined' && document.hidden) {
          return pf != null || flowActive || (fab ? fab.ripplesAlive(now) : false);
        }
        if (pf) pf.advance(dt);
        if (flow) flow.advance(dt);
        const rAlive = fab ? fab.tickRipples(now) : false;
        fab?.setTime(now / 1000); // ambient micro-waves (amp 0 at lower tiers)
        updateEmissive();
        renderScene();
        recordFrame();
        // Ambient dust/pulses keep it alive; else stop when the ripples die.
        return pf != null || flowActive || rAlive;
      },
      {
        requestFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (id) => cancelAnimationFrame(id),
        setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
        clearTimer: (id) => clearTimeout(id),
      },
    );
  }, [recordFrame, updateEmissive, renderScene]);

  const applyCamera = useCallback(() => {
    const t = threeRef.current;
    if (!t) return;
    const c = camRef.current;
    t.camera.position.set(
      c.tx + c.dist * Math.sin(c.phi) * Math.sin(c.theta),
      c.ty + c.dist * Math.cos(c.phi),
      c.tz + c.dist * Math.sin(c.phi) * Math.cos(c.theta),
    );
    t.camera.lookAt(c.tx, c.ty, c.tz);
    t.camera.updateMatrixWorld();
    requestRender();
  }, [requestRender]);

  const pointerRay = useCallback((clientX: number, clientY: number): { origin: Vec3; dir: Vec3; ndc: THREE.Vector2 } | null => {
    const t = threeRef.current;
    const host = viewportRef.current;
    if (!t || !host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const v = new THREE.Vector3(nx, ny, 0.5).unproject(t.camera);
    const o = t.camera.position;
    const d = v.sub(o).normalize();
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z], ndc: new THREE.Vector2(nx, ny) };
  }, []);

  /** Unproject the pointer onto a node's z-plane, in workflow coordinates. */
  const workflowPointAt = useCallback((clientX: number, clientY: number, planeZ: number): Point | null => {
    const ray = pointerRay(clientX, clientY);
    if (!ray) return null;
    return pointerRayToPlane(ray.origin, ray.dir, planeZ);
  }, [pointerRay]);

  // Design tokens live on :root, so both caches resolve once against the
  // documentElement and then never call getComputedStyle again — sync effects
  // stay allocation-light and THREE.Color only ever sees concrete colors.
  const wireColor = useCallback((type: SocketType): string => {
    const cached = colorCacheRef.current.get(type);
    if (cached) return cached;
    const resolved = resolveCssColor(socketColor(type), document.documentElement);
    colorCacheRef.current.set(type, resolved);
    return resolved;
  }, []);

  const capsuleAccent = useCallback((kind: CapsuleKind): string => {
    const cached = accentCacheRef.current.get(kind);
    if (cached) return cached;
    const resolved = resolveCssColor(CAPSULES[kind].accent, document.documentElement);
    accentCacheRef.current.set(kind, resolved);
    return resolved;
  }, []);

  // ---- field profile helpers (curated field — NOT a trained model) ---------
  /** Model family from the current Model capsule's checkpoint id (SD1.5/2.1/XL). */
  const currentFamily = useCallback((): ControlNetFamily => {
    const model = workflow.nodes.find((n) => n.kind === 'model');
    return estimateFamilyFromModelId(String(model?.params.assetId ?? ''));
  }, [workflow]);

  /** Prompt text (positive) feeding the field's prompt-marker adaptation. */
  const currentPromptText = useCallback((): string => {
    const prompt = workflow.nodes.find((n) => n.kind === 'prompt');
    return String(prompt?.params.positive ?? '');
  }, [workflow]);

  /** The curated field profile for a node id (empty profile => ghost disabled). */
  const profileFor = useCallback((nodeId: string): FieldProfile => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return {};
    return fieldProfile(node.kind, currentFamily(), node.params, currentPromptText());
  }, [workflow, currentFamily, currentPromptText]);

  /** True when a node has at least one field axis (ghost is meaningful). */
  const hasProfile = useCallback((nodeId: string): boolean => {
    const p = profileFor(nodeId);
    return !!(p.x || p.y || p.z);
  }, [profileFor]);

  // ---- streaming preview: feed ghost-drag positions to the settle-debouncer -
  /**
   * Debounced live preview while dragging a ghost through an ACTIVE preset's
   * field. Reads the live field slice (streaming on + a preset selected) each
   * call so a mid-drag toggle is honored; the store's runFieldPreview mints the
   * supersede token, so a newer settled position discards a stale in-flight one.
   * No-op (and never queues a render) unless streaming is on with a preset.
   */
  const streamPreview = useCallback((pos: { x: number; y: number; z: number }) => {
    const field = useStudio.getState().field;
    if (!field.streamingEnabled || !field.activePresetId) return;
    previewDebouncerRef.current?.push(normalizePos(pos), (p) => {
      void useStudio.getState().runFieldPreview(p);
    });
  }, []);

  /**
   * Ghost drag ended: cancel any pending settle (spec: cancel on drag end) and,
   * when streaming is armed, fire ONE immediate preview at the resting position
   * so the final spot is always previewed even after a fast release. The store's
   * supersede token makes this safe against any race with an earlier settle.
   */
  const endStreamPreview = useCallback((pos: { x: number; y: number; z: number }) => {
    previewDebouncerRef.current?.cancel();
    const field = useStudio.getState().field;
    if (!field.streamingEnabled || !field.activePresetId) return;
    void useStudio.getState().runFieldPreview(normalizePos(pos));
  }, []);

  // Turning streaming OFF must immediately drop any pending preview render.
  useEffect(() => {
    if (!streamingEnabled) previewDebouncerRef.current?.cancel();
  }, [streamingEnabled]);

  // Unmount: cancel the debouncer so no settle timer outlives the 3D view.
  useEffect(() => {
    const deb = previewDebouncerRef.current;
    return () => deb?.cancel();
  }, []);

  // ---- three.js lifecycle -------------------------------------------------
  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
      console.warn('LumenDeck: WebGL renderer unavailable, falling back to the 2D graph.', err);
      onContextFailedRef.current?.();
      return;
    }
    // Any throw past this point must degrade to the 2D editor, NOT escape the
    // effect: an uncaught passive-effect error would tear down the whole React
    // tree (blank app) since there is no error boundary above this view.
    let cssRenderer: CSS3DRenderer | null = null;
    let ro: ResizeObserver | null = null;
    try {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0); // transparent over the app background
      renderer.domElement.classList.add('graph3d-gl');

      cssRenderer = new CSS3DRenderer();
      cssRenderer.domElement.classList.add('graph3d-css3d');

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(new THREE.Color('#071426'), 2200, 7000);
      const camera = new THREE.PerspectiveCamera(45, 1, 10, 20000);

      scene.add(buildNeonGrid(resolveCssColor('var(--ld-cyan)', host), resolveCssColor('var(--ld-violet)', host)));
      const wireGroup = new THREE.Group();
      scene.add(wireGroup);
      const orbGroup = new THREE.Group();
      scene.add(orbGroup);
      // Ghost + anchor overlays live in their own groups so the v0.13/15 orb and
      // wire sync paths are never disturbed (added/removed alongside, not within).
      const ghostGroup = new THREE.Group();
      scene.add(ghostGroup);
      const anchorGroup = new THREE.Group();
      scene.add(anchorGroup);
      const orbGeometry = makeOrbGeometry(ORB_RADIUS);

      const raycaster = new THREE.Raycaster();
      raycaster.params.Line = { threshold: 6 };

      host.appendChild(renderer.domElement);
      host.appendChild(cssRenderer.domElement);
      threeRef.current = { renderer, cssRenderer, scene, camera, wireGroup, orbGroup, ghostGroup, anchorGroup, orbGeometry, nodeObjects: new Map(), draftLine: null, raycaster };

      // Pre-resolve every socket color once (bug guard: THREE.Color must never
      // see a raw var() token, and sync effects must not hit getComputedStyle).
      for (const type of ALL_SOCKET_TYPES) wireColor(type);

      const resize = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w < 1 || h < 1) return;
        renderer.setSize(w, h);
        cssRenderer!.setSize(w, h);
        postRef.current?.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        requestRender();
      };
      ro = new ResizeObserver(resize);
      ro.observe(host);
      resize();
      applyCamera();

      // Wheel dolly — native non-passive listener so preventDefault sticks.
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const cam = camRef.current;
        cam.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
        applyCamera();
      };
      host.addEventListener('wheel', onWheel, { passive: false });

      // Focus-scroll guard: focusing an off-screen card must never scroll the
      // overflow-hidden 3D layers out of sync with the camera transform.
      const resetScroll = () => {
        host.scrollLeft = 0;
        host.scrollTop = 0;
        cssRenderer!.domElement.scrollLeft = 0;
        cssRenderer!.domElement.scrollTop = 0;
      };
      host.addEventListener('scroll', resetScroll, true);

      setReady(true);
      return () => {
        // Leaving the 3D view must stop any headless ghost-recording timers, or
        // they sample forever and produce a bogus over-long clip on return.
        useStudio.getState().cancelAllGhostRecordings();
        // Leaving the 3D view must also release the audio engine (AudioContext +
        // mic tracks) + any bake sampler, or they leak past the view's lifetime.
        useStudio.getState().stopAudio();
        ro?.disconnect();
        host.removeEventListener('wheel', onWheel);
        host.removeEventListener('scroll', resetScroll, true);
        flushRef.current?.cancel();
        settleDriverRef.current?.stop();
        settleDriverRef.current = null;
        particleFieldRef.current?.dispose();
        particleFieldRef.current = null;
        energyFlowRef.current?.dispose();
        energyFlowRef.current = null;
        starfieldRef.current?.dispose();
        starfieldRef.current = null;
        backdropRef.current?.dispose();
        backdropRef.current = null;
        // Restores the renderer's tone mapping BEFORE renderer.dispose below.
        postRef.current?.dispose();
        postRef.current = null;
        orbsRef.current.clear();
        // Ghost/anchor overlays are disposed by the scene traversal below (their
        // geometries/materials live under the scene); just drop the id maps.
        ghostsSceneRef.current.clear();
        anchorsSceneRef.current.clear();
        ghostChipAnchorsRef.current.clear();
        disposeObject3D(scene); // also disposes orb materials/rings still in the scene
        orbGeometry.dispose();
        renderer.dispose();
        // Release the GL context NOW: browsers cap live WebGL contexts, and
        // dispose() alone keeps the context alive until GC — leaking one per
        // view remount would eventually evict/fail the active context.
        renderer.forceContextLoss();
        renderer.domElement.remove();
        cssRenderer!.domElement.remove();
        threeRef.current = null;
        setReady(false);
      };
    } catch (err) {
      console.warn('LumenDeck: 3D graph scene setup failed, falling back to the 2D graph.', err);
      ro?.disconnect();
      flushRef.current?.cancel();
      threeRef.current = null;
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      cssRenderer?.domElement.remove();
      onContextFailedRef.current?.();
      return;
    }
    // Mount-once: helpers above are stable useCallbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- sync node cards (CSS3D objects) with the workflow -------------------
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    // The card offsets itself inside the plane via its own left/top (workflow
    // coords), so every anchor sits at the canvas origin; only z differs.
    const origin = worldFromCanvas({ x: 0, y: 0 });
    const seen = new Set<string>();
    for (const node of workflow.nodes) {
      seen.add(node.id);
      let obj = t.nodeObjects.get(node.id);
      if (!obj) {
        obj = new CSS3DObject(getAnchor(node.id));
        t.scene.add(obj);
        t.nodeObjects.set(node.id, obj);
      }
      obj.position.set(origin.x, origin.y, zFromNode(node.x) + (node.id === selectedNodeId ? LIFT : 0));
    }
    for (const [id, obj] of t.nodeObjects) {
      if (!seen.has(id)) {
        t.scene.remove(obj);
        t.nodeObjects.delete(id);
        anchorsRef.current.delete(id);
      }
    }
    requestRender();
  }, [ready, workflow, selectedNodeId, requestRender]);

  /** In 'orbs' style every non-selected node renders as a gradient orb. */
  const isOrbNode = useCallback((node: { id: string }): boolean => {
    return graph3dStyle === 'orbs' && node.id !== selectedNodeId;
  }, [graph3dStyle, selectedNodeId]);

  // ---- sync orbs (gradient spheres + value rings) with the workflow --------
  // Rebuilds are minimal: the shared sphere geometry is cached, materials are
  // re-tinted in place, and the ring is only rebuilt when its arc changes
  // (params live-update through this effect via the dirty-flag render loop).
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    const orbs = orbsRef.current;
    const seen = new Set<string>();
    if (graph3dStyle === 'orbs') {
      for (const node of workflow.nodes) {
        if (node.id === selectedNodeId) continue; // its card is expanded in place
        seen.add(node.id);
        const tw = weightT(node.kind, node.params);
        const stops = tw == null ? NEUTRAL_ORB_STOPS : gradientStops(tw);
        const accent = capsuleAccent(node.kind);
        const tintKey = `${stops[0]}|${stops[1]}|${stops[2]}|${accent}`;
        let entry = orbs.get(node.id);
        if (!entry) {
          const group = new THREE.Group();
          const material = makeOrbMaterial(stops, accent, ORB_RADIUS);
          const sphere = new THREE.Mesh(t.orbGeometry, material);
          sphere.userData.nodeId = node.id;
          group.add(sphere);
          t.orbGroup.add(group);
          entry = { group, material, ring: null, ringT: -1, tintKey, anomalyRing: null, anomalyKey: '' };
          orbs.set(node.id, entry);
        } else if (entry.tintKey !== tintKey) {
          updateOrbMaterial(entry.material, stops, accent);
          entry.tintKey = tintKey;
        }
        const ringT = tw ?? -1;
        if (entry.ringT !== ringT) {
          if (entry.ring) {
            entry.group.remove(entry.ring);
            disposeObject3D(entry.ring);
            entry.ring = null;
          }
          if (tw != null) {
            entry.ring = makeOrbRing(ORB_RADIUS, tw, stops[1]); // ramp(t) — the exact weight color
            if (entry.ring) entry.group.add(entry.ring);
          }
          entry.ringT = ringT;
        }
        // Anomaly outline (constellation encoding): a palette-breaking ring for a
        // node with a health error/warning, gated on the effects flag. Additive to
        // the value-ring above — the existing tint/ring/position paths are untouched.
        // The node chip's icon+text carries the same signal (never color alone).
        const anomaly = graph3dEffects === 'off' ? null : nodeAnomaly(node.id, health);
        const anomalyKey = anomaly ?? '';
        if (entry.anomalyKey !== anomalyKey) {
          if (entry.anomalyRing) {
            entry.group.remove(entry.anomalyRing);
            disposeObject3D(entry.anomalyRing);
            entry.anomalyRing = null;
          }
          if (anomaly) {
            entry.anomalyRing = makeAnomalyRing(ORB_RADIUS, anomaly);
            entry.group.add(entry.anomalyRing);
          }
          entry.anomalyKey = anomalyKey;
        }
        // Luminosity: snapshot the activity glow from edit/create recency. This is
        // the idle-safe path (updates on graph changes); the animating loops fade
        // it smoothly while they run (see updateEmissive).
        setOrbEmissive(entry.material, graph3dEffects === 'off' ? 0 : emissiveFor(nodeMeta[node.id], Date.now()));
        const c = orbWorldCenter(node);
        entry.group.position.set(c.x, c.y, c.z);
      }
    }
    // Remove stale orbs: deleted nodes, the selected node, or 'cards' style.
    for (const [id, entry] of orbs) {
      if (seen.has(id)) continue;
      t.orbGroup.remove(entry.group);
      entry.material.dispose();
      if (entry.ring) disposeObject3D(entry.ring); // shared sphere geometry survives
      if (entry.anomalyRing) disposeObject3D(entry.anomalyRing);
      orbs.delete(id);
    }
    // Fabric wells track graph mass. Refresh here (this effect already re-runs on
    // any workflow/selection change); no-op when the fabric flag is off.
    const fab = fabricRef.current;
    if (fab) {
      const { clamped } = fab.update(workflow.nodes);
      if (clamped && !clampWarnedRef.current) {
        console.warn(`LumenDeck: more than ${MAX_WELLS} weighted nodes — the fabric shows the ${MAX_WELLS} deepest wells.`);
        clampWarnedRef.current = true;
      } else if (!clamped) {
        clampWarnedRef.current = false;
      }
    }
    // Rebuild the gravity-dust grid from the same (home) wells so the particles
    // fall toward the current mass distribution. Rich tier only (field non-null).
    particleFieldRef.current?.setWells(packWells(workflow.nodes).wells);
    requestRender();
  }, [ready, workflow, selectedNodeId, graph3dStyle, capsuleAccent, requestRender, graph3dEffects, health, nodeMeta]);

  // ---- gravity fabric lifecycle (constellation GPU overhaul, First Slice) ----
  // Own Group beside the GridHelpers; constructed only when the flag is on, at
  // the tier's density; disposed on flag-off / tier-change / unmount. Wells are
  // refreshed by the orb-reconcile effect above (graph changes), redrawn via the
  // dirty-flag scheduler — there is deliberately NO animation loop here.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    settleDriverRef.current?.stop();
    settleDriverRef.current = null;
    fabricRef.current?.dispose();
    fabricRef.current = null;
    const features = featuresFor(effectsLevel);
    if (!features.fabricTier) { requestRender(); return; }
    const host = viewportRef.current ?? document.documentElement;
    const shallow = resolveCssColor('var(--ld-cyan)', host);
    const deep = resolveCssColor('var(--ld-violet)', host);
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const waveAmp = motionPolicy(reduced).fabricWaves ? features.fabricWaveAmp : 0;
    const fabric = createFabric(features.fabricTier, shallow, deep, waveAmp);
    fabric.update(useStudio.getState().workflow.nodes);
    t.scene.add(fabric.group);
    fabricRef.current = fabric;
    clampWarnedRef.current = false;
    requestRender();
    return () => {
      settleDriverRef.current?.stop();
      settleDriverRef.current = null;
      fabricRef.current?.dispose();
      fabricRef.current = null;
      requestRender();
    };
  }, [ready, effectsLevel, requestRender]);

  // ---- volumetric gravity dust: particles orbit + plunge into mass wells ------
  // Standard tier and up, never under reduced motion. When present it drives a
  // continuous idle loop (the deliberate trade for ambient particles),
  // visibility-gated so a hidden tab draws nothing. Disposed on tier/flag change.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    particleFieldRef.current?.dispose();
    particleFieldRef.current = null;
    const features = featuresFor(effectsLevel);
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (features.particleCount === 0 || !motionPolicy(reduced).particles) { requestRender(); return; }
    const host = viewportRef.current ?? document.documentElement;
    // Cool dust rides the brand cyan; the field derives its warm high-energy
    // tint internally — kinetic + gravitational energy burn it toward starlight.
    const field = createParticleField(
      features.particleCount,
      FABRIC_EXTENT,
      resolveCssColor('var(--ld-cyan)', host),
    );
    field.setWells(packWells(useStudio.getState().workflow.nodes).wells);
    t.scene.add(field.points);
    particleFieldRef.current = field;
    requestRender();
    wakeSettle(); // start the ambient idle loop
    return () => {
      particleFieldRef.current?.dispose();
      particleFieldRef.current = null;
      requestRender();
    };
  }, [ready, effectsLevel, requestRender, wakeSettle]);

  // ---- directed workflow energy: pulses travel each wire source → dest --------
  // Standard tier and up, never under reduced motion. Edge assignments are
  // populated by the wire-sync effect below (same endpoints as the drawn wires);
  // live rerouting during playback/audio goes through routeWiresLive.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    energyFlowRef.current?.dispose();
    energyFlowRef.current = null;
    const features = featuresFor(effectsLevel);
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (features.pulsesPerEdge === 0 || !motionPolicy(reduced).pulses) { requestRender(); return; }
    const flow = createEnergyFlow();
    t.scene.add(flow.points);
    energyFlowRef.current = flow;
    requestRender();
    return () => {
      energyFlowRef.current?.dispose();
      energyFlowRef.current = null;
      requestRender();
    };
  }, [ready, effectsLevel, requestRender]);

  // ---- environment (starfield + cinematic backdrop) + bloom pipeline ----------
  // The starfield is the static parallax anchor (rich+). The opaque backdrop
  // dome exists ONLY alongside the bloom composer (cinematic): UnrealBloomPass
  // cannot preserve canvas alpha, so cinematic frames must be opaque. Both are
  // zero-cost per frame; the composer is created/disposed with the tier.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    starfieldRef.current?.dispose();
    starfieldRef.current = null;
    backdropRef.current?.dispose();
    backdropRef.current = null;
    postRef.current?.dispose();
    postRef.current = null;
    const features = featuresFor(effectsLevel);
    const host = viewportRef.current ?? document.documentElement;
    if (features.starfield > 0) {
      const stars = createStarfield(
        features.starfield,
        7000,
        11000,
        resolveCssColor('var(--ld-cyan)', host),
        '#f4ead8',
      );
      t.scene.add(stars.object);
      starfieldRef.current = stars;
    }
    if (features.bloom) {
      // Dome gradient mirrors the .graph3d-wrap CSS backdrop (no visual jump).
      const dome = createBackdrop(12000, '#0b1220', '#071426');
      t.scene.add(dome.object);
      backdropRef.current = dome;
      postRef.current = createPostPipeline(t.renderer, t.scene, t.camera, {
        strength: features.bloomStrength,
      });
      const w = viewportRef.current?.clientWidth ?? 0;
      const h = viewportRef.current?.clientHeight ?? 0;
      if (w > 0 && h > 0) postRef.current.setSize(w, h);
    }
    requestRender();
    return () => {
      starfieldRef.current?.dispose();
      starfieldRef.current = null;
      backdropRef.current?.dispose();
      backdropRef.current = null;
      postRef.current?.dispose();
      postRef.current = null;
      requestRender();
    };
  }, [ready, effectsLevel, requestRender]);

  // ---- event ripples: a fabric wave when a node NEWLY errors (Phase 2C) ------
  // Diffs the node-attributed ERROR set across health commits; each newly-errored
  // node fires ONE ripple at its orb, through the shared flash limiter (≤3/sec).
  // Reduced motion + flag-off suppress ripples — the persistent anomaly ring is
  // the static equivalent. Pre-existing errors at mount are seeded, never bursted.
  useEffect(() => {
    if (!ready) return;
    const cur = new Set<string>();
    for (const h of health) if (h.nodeId && h.severity === 'error') cur.add(h.nodeId);
    const prev = prevErrorNodesRef.current;
    prevErrorNodesRef.current = cur;
    if (!healthSeededRef.current) { healthSeededRef.current = true; return; } // seed, no burst
    const fab = fabricRef.current;
    if (!fab || graph3dEffects === 'off') return;
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const now = performance.now();
    const fl = flashLimiterRef.current!;
    let pushed = false;
    for (const nodeId of cur) {
      if (prev.has(nodeId)) continue; // already errored — not a NEW event
      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      if (!fl.tryAdd(now)) break; // flash budget spent this second
      const c = orbWorldCenter(node);
      fab.pushRipple(c.x, c.z, now);
      pushed = true;
    }
    if (pushed) wakeSettle();
  }, [ready, health, workflow, graph3dEffects, wakeSettle]);

  // Playback/audio own the frame → stop the settle driver (double-render safety).
  // Returning to idle with dust/pulses/a live ripple → resume the ambient loop.
  useEffect(() => {
    if (transportPlaying || audioRunning) {
      settleDriverRef.current?.stop();
      settleDriverRef.current = null;
    } else if (
      particleFieldRef.current != null ||
      energyFlowRef.current?.active() ||
      fabricRef.current?.ripplesAlive(performance.now())
    ) {
      wakeSettle();
    }
  }, [transportPlaying, audioRunning, wakeSettle]);

  // ---- ghost chip DOM anchors (value chip + toolbar + intensity slider) -----
  const getGhostChipAnchor = useCallback((id: string): HTMLDivElement => {
    let el = ghostChipAnchorsRef.current.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'graph3d-ghost-anchor';
      ghostChipAnchorsRef.current.set(id, el);
    }
    return el;
  }, []);

  /** World center a ghost's field position resolves to (origin orb + field offset). */
  const ghostWorldCenter = useCallback((ghost: Ghost): WorldPoint => {
    const node = workflow.nodes.find((n) => n.id === ghost.nodeId);
    const origin = node ? orbWorldCenter(node) : { x: 0, y: 0, z: 0 };
    return fieldPosToWorld(ghost.pos, origin);
  }, [workflow]);

  // ---- sync ghost controllers (translucent orbs + axis guides + chips) ------
  // Reconciled EXACTLY like the orb sync: add on spawn, re-position on move,
  // remove/dispose on collapse. The DOM chip rides a CSS3DObject at the ghost
  // center. Never touches orbGroup/wireGroup, so the v0.13/15 paths are intact.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    const scene = ghostsSceneRef.current;
    const seen = new Set<string>();
    for (const ghost of ghosts) {
      seen.add(ghost.id);
      const profile = profileFor(ghost.nodeId);
      const axes = [profile.x, profile.y, profile.z];
      const profileKey = axes.map((a) => a?.label ?? '-').join('|');
      let entry = scene.get(ghost.id);
      if (!entry) {
        const group = new THREE.Group();
        // Translucent, wireframe-ish duplicate of the orb (reuse shared geometry).
        const material = makeOrbMaterial(gradientStops(0.5), capsuleAccent(
          workflow.nodes.find((n) => n.id === ghost.nodeId)?.kind ?? 'note',
        ), ORB_RADIUS);
        material.transparent = true;
        material.opacity = GHOST_OPACITY;
        material.wireframe = true;
        material.depthWrite = false;
        const sphere = new THREE.Mesh(t.orbGeometry, material);
        sphere.userData.ghostId = ghost.id;
        sphere.scale.setScalar(0.72);
        group.add(sphere);
        // A CSS3D object hosts the ghost's DOM chip (value/toolbar/slider).
        const chip = new CSS3DObject(getGhostChipAnchor(ghost.id));
        chip.userData.ghostChip = ghost.id;
        group.add(chip);
        t.ghostGroup.add(group);
        entry = { group, material, profileKey: '' };
        scene.set(ghost.id, entry);
      }
      // (Re)build the faint labeled axis guides when the profile changes.
      if (entry.profileKey !== profileKey) {
        for (const child of [...entry.group.children]) {
          if (child.userData.axisGuide) {
            entry.group.remove(child);
            disposeObject3D(child);
          }
        }
        const axisColor: [string, string, string] = ['#34d6f4', '#7c3aed', '#ff8a3d'];
        const dirs: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        axes.forEach((axis, i) => {
          if (!axis) return;
          const [dx, dy, dz] = dirs[i];
          const len = ORB_RADIUS + 34;
          const line = makeWireLine(
            { x: -dx * len, y: -dy * len, z: -dz * len },
            { x: dx * len, y: dy * len, z: dz * len },
            axisColor[i],
            true,
          );
          line.userData.axisGuide = true;
          entry.group.add(line);
        });
        entry.profileKey = profileKey;
      }
      const c = ghostWorldCenter(ghost);
      entry.group.position.set(c.x, c.y, c.z);
    }
    for (const [id, entry] of scene) {
      if (seen.has(id)) continue;
      t.ghostGroup.remove(entry.group);
      entry.material.dispose();
      // The ghost sphere REUSES the shared t.orbGeometry; strip it before
      // disposeObject3D so it can't dispose geometry every orb + other ghost
      // still references (that would blank the whole scene).
      const sphere = entry.group.children.find(
        (c) => (c as { userData?: { ghostId?: string } }).userData?.ghostId,
      );
      if (sphere) entry.group.remove(sphere);
      disposeObject3D(entry.group); // axis guides (own geometry) + chip
      scene.delete(id);
      ghostChipAnchorsRef.current.delete(id);
    }
    requestRender();
  }, [ready, ghosts, workflow, profileFor, capsuleAccent, ghostWorldCenter, getGhostChipAnchor, requestRender]);

  // ---- sync anchor markers (clickable saved sweet-spots) --------------------
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    const scene = anchorsSceneRef.current;
    const seen = new Set<string>();
    for (const anchor of anchors) {
      seen.add(anchor.id);
      let entry = scene.get(anchor.id);
      if (!entry) {
        const group = new THREE.Group();
        const geometry = new THREE.OctahedronGeometry(ANCHOR_RADIUS, 0);
        const material = new THREE.MeshBasicMaterial({
          color: new THREE.Color('#ffd27a'),
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.anchorId = anchor.id;
        group.add(mesh);
        t.anchorGroup.add(group);
        entry = { group, mesh };
        scene.set(anchor.id, entry);
      }
      const node = workflow.nodes.find((n) => n.id === anchor.nodeId);
      const origin = node ? orbWorldCenter(node) : { x: 0, y: 0, z: 0 };
      const c = fieldPosToWorld(anchor.pos, origin);
      entry.group.position.set(c.x, c.y, c.z);
    }
    for (const [id, entry] of scene) {
      if (seen.has(id)) continue;
      t.anchorGroup.remove(entry.group);
      disposeObject3D(entry.group);
      scene.delete(id);
    }
    requestRender();
  }, [ready, anchors, workflow, requestRender]);

  // ---- sync wires (3D bezier lines) with the workflow edges ----------------
  // Lines are keyed by edge id and REUSED across commits: routine changes
  // (node drags, param edits) only re-route existing geometry in place — no
  // new materials, colors, or geometries — so nothing churns per change and
  // the dirty-flag loop stays idle between actual mutations.
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    const existing = new Map<string, THREE.Line>();
    for (const child of t.wireGroup.children) {
      if (typeof child.userData.edgeId === 'string') existing.set(child.userData.edgeId as string, child as THREE.Line);
    }
    const seen = new Set<string>();
    const flow = energyFlowRef.current;
    const flowEdges: FlowEdge[] = [];
    const activityNow = Date.now();
    for (const edge of workflow.edges) {
      const fromNode = workflow.nodes.find((n) => n.id === edge.from.node);
      const toNode = workflow.nodes.find((n) => n.id === edge.to.node);
      if (!fromNode || !toNode) continue;
      // Anchor at the socket for expanded cards, at the orb center for orbs;
      // then pull orb endpoints out to the sphere surface toward the far end.
      const aAnchor: WorldPoint = isOrbNode(fromNode)
        ? orbWorldCenter(fromNode)
        : socketWorldPoint(fromNode, edge.from.socket, 'out', fromNode.id === selectedNodeId);
      const bAnchor: WorldPoint = isOrbNode(toNode)
        ? orbWorldCenter(toNode)
        : socketWorldPoint(toNode, edge.to.socket, 'in', toNode.id === selectedNodeId);
      const a = isOrbNode(fromNode) ? orbSurfacePoint(aAnchor, bAnchor, ORB_RADIUS) : aAnchor;
      const b = isOrbNode(toNode) ? orbSurfacePoint(bAnchor, aAnchor, ORB_RADIUS) : bAnchor;
      const type = CAPSULES[fromNode.kind].outputs.find((s) => s.id === edge.from.socket)?.type ?? 'image';
      const line = existing.get(edge.id);
      if (line) {
        updateWireLine(line, a, b); // an edge's socket (and thus color) never changes
      } else {
        const created = makeWireLine(a, b, wireColor(type));
        created.userData.edgeId = edge.id;
        t.wireGroup.add(created);
      }
      seen.add(edge.id);
      if (flow) {
        // The pulse rides the EXACT curve the wire renders (same control math).
        const c = wireControl(a, b);
        flowEdges.push({
          id: edge.id,
          ax: a.x, ay: a.y, az: a.z,
          cx: c.x, cy: c.y, cz: c.z,
          bx: b.x, by: b.y, bz: b.z,
          color: wireColor(type),
          activity: Math.max(
            emissiveFor(nodeMeta[edge.from.node], activityNow),
            emissiveFor(nodeMeta[edge.to.node], activityNow),
          ),
          blocked:
            nodeAnomaly(edge.from.node, health) === 'error' ||
            nodeAnomaly(edge.to.node, health) === 'error',
        });
      }
    }
    for (const [id, line] of existing) {
      if (seen.has(id)) continue;
      t.wireGroup.remove(line);
      disposeObject3D(line);
    }
    if (flow) {
      const dropped = flow.setEdges(flowEdges, featuresFor(effectsLevel).pulsesPerEdge);
      if (dropped > 0 && !flowDropWarnedRef.current) {
        console.warn(`LumenDeck: pulse capacity reached — ${dropped} wire(s) animate without energy pulses.`);
        flowDropWarnedRef.current = true;
      }
      if (flow.active()) wakeSettle();
    }
    requestRender();
  }, [ready, workflow, selectedNodeId, isOrbNode, wireColor, requestRender, health, nodeMeta, effectsLevel, wakeSettle]);

  // ---- in-progress (draft) wire, dashed -----------------------------------
  useEffect(() => {
    if (!ready) return;
    const t = threeRef.current;
    if (!t) return;
    if (!wire) {
      if (t.draftLine) {
        t.scene.remove(t.draftLine);
        disposeObject3D(t.draftLine);
        t.draftLine = null;
        requestRender();
      }
      return;
    }
    const fromNode = workflow.nodes.find((n) => n.id === wire.fromNode);
    if (!fromNode) return;
    const selectedFrom = fromNode.id === selectedNodeId;
    const b = worldFromCanvas(wire.cursor, zFromNode(fromNode.x) + (selectedFrom ? LIFT : 0));
    const a = isOrbNode(fromNode)
      ? orbSurfacePoint(orbWorldCenter(fromNode), b, ORB_RADIUS)
      : socketWorldPoint(fromNode, wire.fromSocket.id, 'out', selectedFrom);
    if (t.draftLine) {
      updateWireLine(t.draftLine, a, b);
    } else {
      t.draftLine = makeWireLine(a, b, wireColor(wire.fromSocket.type), true);
      t.scene.add(t.draftLine);
    }
    requestRender();
  }, [ready, wire, workflow, selectedNodeId, isOrbNode, wireColor, requestRender]);

  // ---- motion playback loop ------------------------------------------------
  // A CONTINUOUS rAF that runs ONLY while transport.playing. It advances a
  // local clock, samples the active clip, and overlays orb-motion offsets /
  // value-tints on top of the static v0.13 orb state — then renders directly
  // (bypassing the dirty-flag scheduler). When playback stops the orbs are
  // restored to their static positions/values with one final idle flush, and
  // the scene returns to the dirty-flag idle loop untouched.

  /**
   * Reroute every wire from the orbs' CURRENT world centers (moved during
   * playback) so links follow the animated orbs. The selected node has no orb
   * entry — it falls back to its socket/orb base position.
   */
  const routeWiresLive = useCallback(() => {
    const t = threeRef.current;
    if (!t) return;
    const wf = useStudio.getState().workflow;
    const sel = useStudio.getState().selectedNodeId;
    const orbs = orbsRef.current;
    const orbCenter = (node: WorkflowNode): WorldPoint => {
      const entry = orbs.get(node.id);
      if (entry) {
        const p = entry.group.position;
        return { x: p.x, y: p.y, z: p.z };
      }
      return orbWorldCenter(node);
    };
    for (const child of t.wireGroup.children) {
      const edgeId = child.userData.edgeId as string | undefined;
      if (!edgeId) continue;
      const edge = wf.edges.find((e) => e.id === edgeId);
      if (!edge) continue;
      const fromNode = wf.nodes.find((n) => n.id === edge.from.node);
      const toNode = wf.nodes.find((n) => n.id === edge.to.node);
      if (!fromNode || !toNode) continue;
      const fromOrb = graph3dStyle === 'orbs' && fromNode.id !== sel;
      const toOrb = graph3dStyle === 'orbs' && toNode.id !== sel;
      const aAnchor: WorldPoint = fromOrb ? orbCenter(fromNode) : socketWorldPoint(fromNode, edge.from.socket, 'out', fromNode.id === sel);
      const bAnchor: WorldPoint = toOrb ? orbCenter(toNode) : socketWorldPoint(toNode, edge.to.socket, 'in', toNode.id === sel);
      const a = fromOrb ? orbSurfacePoint(aAnchor, bAnchor, ORB_RADIUS) : aAnchor;
      const b = toOrb ? orbSurfacePoint(bAnchor, aAnchor, ORB_RADIUS) : bAnchor;
      updateWireLine(child as THREE.Line, a, b);
      // Energy pulses follow the rerouted wire (same curve, same control math).
      const flow = energyFlowRef.current;
      if (flow) {
        const c = wireControl(a, b);
        flow.updateGeometry(edgeId, a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }
    }
    // Fabric depressions follow the live orbs (playback/audio move orbs via
    // direct scene mutation, no store commit) so wells never detach. On restore,
    // orbs are back at home and this re-homes the wells for free. No-op if the
    // fabric flag is off. Depth/sigma come from the last home re-pack.
    const fab = fabricRef.current;
    if (fab) {
      fab.syncLive((nodeId) => {
        const e = orbs.get(nodeId);
        return e ? { x: e.group.position.x, z: e.group.position.z } : undefined;
      });
    }
  }, [graph3dStyle]);

  /** Apply one animated frame (positions, scale, tint, ring) to every orb. */
  const applyPlaybackFrame = useCallback((clip: MotionClip, time: number) => {
    const t = threeRef.current;
    if (!t) return;
    const wf = useStudio.getState().workflow;
    const sel = useStudio.getState().selectedNodeId;
    const sampled = sampleClip(clip, time);
    for (const node of wf.nodes) {
      if (node.id === sel) continue; // the expanded card never moves
      const entry = orbsRef.current.get(node.id);
      if (!entry) continue;
      // Overlay any sampled track values onto the node's live params, then
      // normalize with the SAME per-kind weight rule the static tint uses.
      let params = node.params;
      let overlaid = false;
      for (const paramId of Object.keys(node.params)) {
        const v = sampled.get(trackKey(node.id, paramId));
        if (v != null) { if (!overlaid) { params = { ...node.params }; overlaid = true; } params[paramId] = v; }
      }
      // Also honor bound params not already present in node.params.
      for (const track of clip.tracks) {
        if (track.nodeId !== node.id) continue;
        const v = sampled.get(trackKey(node.id, track.param));
        if (v != null && params[track.param] !== v) { if (!overlaid) { params = { ...node.params }; overlaid = true; } params[track.param] = v; }
      }
      const tw = weightT(node.kind, params);
      const valueT = tw ?? 0;
      const orb = clip.orbMotions[node.id] ?? { style: 'still' as const, speed: 1, amplitude: 1 };
      // motionOffset returns offsets already in WORLD units (the demo authors
      // amplitude ~= world units, e.g. orbit amplitude 60). Applied directly.
      const off = motionOffset(orb, valueT, time);
      const base = orbWorldCenter(node);
      entry.group.position.set(base.x + off.dx, base.y + off.dy, base.z + off.dz);
      entry.group.scale.setScalar(off.scale);
      // Re-tint gradient + ring from the sampled value (reuse the static path).
      const stops = tw == null ? NEUTRAL_ORB_STOPS : gradientStops(tw);
      const accent = capsuleAccent(node.kind);
      const tintKey = `${stops[0]}|${stops[1]}|${stops[2]}|${accent}`;
      if (entry.tintKey !== tintKey) {
        updateOrbMaterial(entry.material, stops, accent);
        entry.tintKey = tintKey;
      }
      const ringT = tw ?? -1;
      if (entry.ringT !== ringT) {
        if (entry.ring) { entry.group.remove(entry.ring); disposeObject3D(entry.ring); entry.ring = null; }
        if (tw != null) {
          entry.ring = makeOrbRing(ORB_RADIUS, tw, stops[1]);
          if (entry.ring) entry.group.add(entry.ring);
        }
        entry.ringT = ringT;
      }
    }
    routeWiresLive();
  }, [capsuleAccent, routeWiresLive]);

  /** Restore every orb to its STATIC position/scale/tint (one idle flush). */
  const restoreStaticOrbs = useCallback(() => {
    const t = threeRef.current;
    if (!t) return;
    const wf = useStudio.getState().workflow;
    const sel = useStudio.getState().selectedNodeId;
    for (const node of wf.nodes) {
      if (node.id === sel) continue;
      const entry = orbsRef.current.get(node.id);
      if (!entry) continue;
      const tw = weightT(node.kind, node.params);
      const stops = tw == null ? NEUTRAL_ORB_STOPS : gradientStops(tw);
      const accent = capsuleAccent(node.kind);
      const tintKey = `${stops[0]}|${stops[1]}|${stops[2]}|${accent}`;
      if (entry.tintKey !== tintKey) { updateOrbMaterial(entry.material, stops, accent); entry.tintKey = tintKey; }
      const ringT = tw ?? -1;
      if (entry.ringT !== ringT) {
        if (entry.ring) { entry.group.remove(entry.ring); disposeObject3D(entry.ring); entry.ring = null; }
        if (tw != null) { entry.ring = makeOrbRing(ORB_RADIUS, tw, stops[1]); if (entry.ring) entry.group.add(entry.ring); }
        entry.ringT = ringT;
      }
      const c = orbWorldCenter(node);
      entry.group.position.set(c.x, c.y, c.z);
      entry.group.scale.setScalar(1);
    }
    routeWiresLive();
    updateEmissive(); // reset the glow snapshot so a stopped loop leaves no stranded emissive
    requestRender();
  }, [capsuleAccent, routeWiresLive, requestRender, updateEmissive]);

  useEffect(() => {
    if (!ready || !transportPlaying) return;
    const store = useStudio.getState;
    const first = store();
    const clip = first.motion.clips.find((c) => c.id === first.motion.activeClipId) ?? null;
    // Guard: nothing to play (no active clip) => leave the idle loop alone.
    if (!clip) return;
    const clipId = clip.id;

    // AUTHORITATIVE PLAYHEAD lives here in a wall-clock ref, NOT in the store.
    let localT = first.transport.t;
    // Pressing Play at (or past) the end of a non-looping clip restarts from 0
    // rather than instantly re-ending.
    if (!clip.loop && clip.duration > 0 && localT >= clip.duration) localT = 0;
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let last = nowMs();
    let lastWrite = last;

    // The tick is driven by BOTH rAF (smooth when visible) AND a ~30ms timer
    // fallback via createPlaybackDriver, so the playhead keeps advancing on a
    // real WALL clock even when rAF is starved (hidden/minimized/occluded/
    // headless) — the invariant that playback must survive occluded windows.
    const step = (): boolean => {
      const t = threeRef.current;
      const s = store();
      // Resolve the STILL-LIVE active clip by id every tick — NO stale fallback.
      // If the clip we started on is gone (deleted / deactivated mid-play), stop
      // the loop and clear transport so nothing is left "playing" a dead clip.
      const active = s.motion.clips.find((c) => c.id === clipId) ?? null;
      if (!t || !active || s.motion.activeClipId !== clipId) {
        s.transport.stop();
        return false; // self-cancel; cleanup restores the idle scene
      }
      const now = nowMs();
      const dt = (now - last) / 1000;
      last = now;
      const { t: nextT, ended } = advancePlayback({
        t: localT,
        dt,
        rate: s.transport.playbackRate || 1,
        duration: active.duration,
        loop: active.loop,
      });
      localT = nextT;
      applyPlaybackFrame(active, localT);
      fabricRef.current?.tickRipples(now); // ripples animate on the playback frame (no separate driver)
      fabricRef.current?.setTime(now / 1000);
      particleFieldRef.current?.advance(dt); // ambient dust drifts on the playback frame too
      energyFlowRef.current?.advance(dt); // wire pulses keep flowing during playback
      updateEmissive(); // luminosity fades smoothly during playback
      renderScene();
      recordFrame();
      if (ended) {
        // Non-looping clip reached the end: settle the playhead AT the end (so
        // the scrubber shows the final frame) and pause. Cleanup restores idle.
        s.transport.pause();
        s.transport.seek(localT);
        return false;
      }
      // Throttle the store write (coarse UI readout only); the authoritative
      // playhead is `localT` above. A low HZ keeps the persistence debounce alive.
      if (now - lastWrite >= 1000 / TRANSPORT_WRITE_HZ) {
        lastWrite = now;
        s.transport.seek(localT);
      }
      return true;
    };

    playbackDriver.current = createPlaybackDriver(step, {
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
      setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
      clearTimer: (id) => clearTimeout(id),
    });

    return () => {
      if (playbackDriver.current) {
        playbackDriver.current.stop();
        playbackDriver.current = null;
      }
      // Final EXACT playhead write. The loop only wrote transport.t at ~6Hz, so
      // the store readout can be up to ~166ms stale when playback stops. On a
      // PAUSE (playing false, t != 0) commit the authoritative localT so the
      // scrubber/readout land precisely; a STOP (t === 0) and non-looping END
      // (already seeked to duration) are left untouched.
      const tr = useStudio.getState().transport;
      if (!tr.playing && tr.t !== 0 && tr.t !== localT) tr.seek(localT);
      restoreStaticOrbs();
    };
  }, [ready, transportPlaying, activeClipId, applyPlaybackFrame, restoreStaticOrbs, renderScene]);

  // ---- scrub preview (paused): seeking updates orbs live -------------------
  // A transient store subscription (NOT a React subscription) so scrubbing the
  // playhead while PAUSED repaints the orbs at that time without re-rendering
  // this heavy component. During playback the rAF owns the frame, so this
  // listener early-returns. Fully idle otherwise (fires only on state changes).
  useEffect(() => {
    if (!ready) return;
    let lastT = useStudio.getState().transport.t;
    const unsub = useStudio.subscribe((s) => {
      if (s.transport.playing) { lastT = s.transport.t; return; } // rAF owns it
      if (s.transport.t === lastT) return; // not a seek
      lastT = s.transport.t;
      const clip = s.motion.clips.find((c) => c.id === s.motion.activeClipId) ?? null;
      const t = threeRef.current;
      if (!clip || !t) return;
      applyPlaybackFrame(clip, s.transport.t);
      renderScene();
      recordFrame();
    });
    return unsub;
  }, [ready, applyPlaybackFrame, renderScene]);

  // ---- audio reactive overlay ----------------------------------------------
  // While audio.running, each rAF frame maps the engine's live bands into the
  // SAME transient orb offset/ring overlay the motion-playback preview uses
  // (position/scale/ring) WITHOUT writing workflow params. Reuses restoreStaticOrbs
  // on teardown, exactly like playback. Audio + motion playback are mutually
  // exclusive (the store stops one when the other starts), so they never both
  // drive the orbs. rAF is acceptable here: reactivity only matters on-screen,
  // and the engine is torn down on unmount so the AudioContext/mic never leak.

  /** Apply one audio reaction frame (offset + scale + ring sweep) to every orb. */
  const applyAudioFrame = useCallback((reaction: AudioReaction) => {
    const t = threeRef.current;
    if (!t) return;
    const wf = useStudio.getState().workflow;
    const sel = useStudio.getState().selectedNodeId;
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    for (const node of wf.nodes) {
      if (node.id === sel) continue; // the expanded card never moves
      const entry = orbsRef.current.get(node.id);
      if (!entry) continue;
      const base = orbWorldCenter(node);
      const off = reaction.offsets.get(node.id);
      if (off) {
        entry.group.position.set(base.x + off.dx, base.y + off.dy, base.z + off.dz);
        entry.group.scale.setScalar(off.scale);
      } else {
        entry.group.position.set(base.x, base.y, base.z);
        entry.group.scale.setScalar(1);
      }
      // Ring sweep: quantize the audio ring value to bounded buckets so the ring
      // geometry is only rebuilt when the bucket changes (never per-frame churn),
      // matching the static/playback ring-rebuild philosophy. restoreStaticOrbs
      // rebuilds the real (param-weight) ring on teardown, so this self-heals.
      const ringVal = reaction.ringValues.get(node.id);
      if (ringVal != null) {
        const q = Math.round(clamp01(ringVal) * 10) / 10;
        if (entry.ringT !== q) {
          if (entry.ring) { entry.group.remove(entry.ring); disposeObject3D(entry.ring); entry.ring = null; }
          const stops = gradientStops(q);
          entry.ring = makeOrbRing(ORB_RADIUS, q, stops[1]);
          if (entry.ring) entry.group.add(entry.ring);
          const accent = capsuleAccent(node.kind);
          updateOrbMaterial(entry.material, stops, accent);
          entry.tintKey = `${stops[0]}|${stops[1]}|${stops[2]}|${accent}`;
          entry.ringT = q;
        }
      }
    }
    routeWiresLive();
  }, [capsuleAccent, routeWiresLive]);

  useEffect(() => {
    if (!ready || !audioRunning) return;
    let raf = 0;
    let lastTick = performance.now();
    const tick = () => {
      const t = threeRef.current;
      const s = useStudio.getState();
      // Stop if audio ended or motion playback took over (mutual exclusion).
      if (!t || !s.audio.running || s.transport.playing) return;
      const nowT = performance.now();
      const dt = (nowT - lastTick) / 1000;
      lastTick = nowT;
      const bands = scaleBands(computeBands(readAudioFrequency()), s.audio.sensitivity);
      const reaction = applyAudio(bands, s.audio.mapping);
      applyAudioFrame(reaction);
      fabricRef.current?.tickRipples(nowT); // ripples animate on the audio frame
      fabricRef.current?.setTime(nowT / 1000);
      particleFieldRef.current?.advance(dt); // ambient dust drifts on the audio frame too
      energyFlowRef.current?.advance(dt); // wire pulses keep flowing during audio
      updateEmissive(); // luminosity fades smoothly during audio
      renderScene();
      recordFrame();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Settle the orbs back to their static positions/values (one idle flush).
      restoreStaticOrbs();
    };
  }, [ready, audioRunning, applyAudioFrame, restoreStaticOrbs, renderScene]);

  // ---- camera actions ------------------------------------------------------
  const resetCamera = () => {
    camRef.current = { tx: 0, ty: 0, tz: 0, ...DEFAULT_CAM };
    applyCamera();
  };

  const fitCamera = useCallback(() => {
    const t = threeRef.current;
    const nodes = useStudio.getState().workflow.nodes;
    if (!t || nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const node of nodes) {
      const z = zFromNode(node.x);
      const tl = worldFromCanvas({ x: node.x, y: node.y }, z);
      const br = worldFromCanvas({ x: node.x + NODE_WIDTH, y: node.y + 180 }, z);
      minX = Math.min(minX, tl.x); maxX = Math.max(maxX, br.x);
      minY = Math.min(minY, br.y); maxY = Math.max(maxY, tl.y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const radius = Math.max(200, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2);
    const fov = (t.camera.fov * Math.PI) / 180;
    const fitH = radius / Math.tan(fov / 2);
    const fitW = fitH / Math.max(0.1, t.camera.aspect);
    const cam = camRef.current;
    cam.tx = (minX + maxX) / 2;
    cam.ty = (minY + maxY) / 2;
    cam.tz = (minZ + maxZ) / 2;
    cam.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, 1.12 * Math.max(fitH, fitW)));
    applyCamera();
  }, [applyCamera]);

  // ---- node/port interactions (same store actions as the 2D editor) --------
  const onHeadDown = (nodeId: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    selectNode(nodeId);
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const planeZ = zFromNode(node.x) + LIFT; // node is selected while dragging
    const p = workflowPointAt(e.clientX, e.clientY, planeZ);
    if (!p) return;
    dragRef.current = { nodeId, offsetX: p.x - node.x, offsetY: p.y - node.y, planeZ };
  };

  const onPortDown = (nodeId: string) => (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => {
    e.stopPropagation();
    if (dir !== 'out') return; // wires are drawn from outputs to inputs
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setWire({ fromNode: nodeId, fromSocket: socket, cursor: socketPoint(node, socket.id, 'out') });
  };

  const onPortUp = (nodeId: string) => (socket: SocketDef, dir: 'in' | 'out', e: React.PointerEvent) => {
    if (!wire || dir !== 'in') return;
    e.stopPropagation();
    connectSockets({ node: wire.fromNode, socket: wire.fromSocket.id }, { node: nodeId, socket: socket.id });
    setWire(null);
  };

  const onNodeKey = (nodeId: string) => (e: React.KeyboardEvent) => {
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateCapsule(nodeId);
      return;
    }
    const step = e.shiftKey ? 1 : 8;
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveNodeTo(nodeId, node.x - step, node.y); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveNodeTo(nodeId, node.x + step, node.y); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveNodeTo(nodeId, node.x, node.y - step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveNodeTo(nodeId, node.x, node.y + step); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCapsule(nodeId); }
  };

  // Ports that would (in)validly accept the in-progress wire (mirrors 2D).
  const candidateFor = (nodeId: string): { ok: Set<string>; bad: Set<string> } => {
    const ok = new Set<string>();
    const bad = new Set<string>();
    if (!wire || wire.fromNode === nodeId) return { ok, bad };
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok, bad };
    for (const inp of CAPSULES[node.kind].inputs) {
      const res = canConnect(workflow, { node: wire.fromNode, socket: wire.fromSocket.id }, { node: nodeId, socket: inp.id });
      (res.ok ? ok : bad).add(`in:${inp.id}`);
    }
    return { ok, bad };
  };

  /**
   * Expand a node and move keyboard focus onto its editor card once React has
   * swapped the chip/orb for the card (next frame). Focusing the card keeps
   * the existing keyboard contract flowing after an orb click.
   */
  const expandNode = useCallback((nodeId: string) => {
    selectNode(nodeId);
    requestAnimationFrame(() => {
      anchorsRef.current.get(nodeId)?.querySelector<HTMLElement>('.gnode')?.focus();
    });
  }, [selectNode]);

  // ---- background interactions: orbit / pan / click-to-select/disconnect ---
  /** Raycast the orb spheres; returns the hit node id (click = expand). */
  const tryPickOrbAt = (clientX: number, clientY: number): string | null => {
    const t = threeRef.current;
    if (!t || t.orbGroup.children.length === 0) return null;
    const ray = pointerRay(clientX, clientY);
    if (!ray) return null;
    t.raycaster.setFromCamera(ray.ndc, t.camera);
    const hits = t.raycaster.intersectObjects(t.orbGroup.children, true);
    const hit = hits.find((h) => typeof h.object.userData.nodeId === 'string');
    return hit ? (hit.object.userData.nodeId as string) : null;
  };

  const tryDisconnectAt = (clientX: number, clientY: number) => {
    const t = threeRef.current;
    if (!t) return;
    const ray = pointerRay(clientX, clientY);
    if (!ray) return;
    t.raycaster.setFromCamera(ray.ndc, t.camera);
    const hits = t.raycaster.intersectObjects(t.wireGroup.children, false);
    const hit = hits.find((h) => typeof h.object.userData.edgeId === 'string');
    if (hit) disconnectEdge(hit.object.userData.edgeId as string);
  };

  /** Raycast the ghost spheres; returns the hit ghost id (drag = fly the ghost). */
  const tryPickGhostAt = (clientX: number, clientY: number): string | null => {
    const t = threeRef.current;
    if (!t || t.ghostGroup.children.length === 0) return null;
    const ray = pointerRay(clientX, clientY);
    if (!ray) return null;
    t.raycaster.setFromCamera(ray.ndc, t.camera);
    const hits = t.raycaster.intersectObjects(t.ghostGroup.children, true);
    const hit = hits.find((h) => typeof h.object.userData.ghostId === 'string');
    return hit ? (hit.object.userData.ghostId as string) : null;
  };

  /** Raycast the anchor markers; returns the hit anchor id (click = restore). */
  const tryPickAnchorAt = (clientX: number, clientY: number): string | null => {
    const t = threeRef.current;
    if (!t || t.anchorGroup.children.length === 0) return null;
    const ray = pointerRay(clientX, clientY);
    if (!ray) return null;
    t.raycaster.setFromCamera(ray.ndc, t.camera);
    const hits = t.raycaster.intersectObjects(t.anchorGroup.children, true);
    const hit = hits.find((h) => typeof h.object.userData.anchorId === 'string');
    return hit ? (hit.object.userData.anchorId as string) : null;
  };

  /** Project a world point to viewport-relative screen px (for the ring dial pivot). */
  const worldToScreen = (p: WorldPoint): { x: number; y: number } | null => {
    const t = threeRef.current;
    const host = viewportRef.current;
    if (!t || !host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const v = new THREE.Vector3(p.x, p.y, p.z).project(t.camera);
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  };

  /**
   * Start a ring-dial drag if the pointer landed on an orb's equatorial ring
   * band (projected). Returns true when a dial drag was started (so the caller
   * suppresses orbit/expand). The ring is the node's PRIMARY value dial (§1),
   * always on and independent of any ghost.
   */
  const tryStartRingDrag = (clientX: number, clientY: number): boolean => {
    const nodeId = tryPickOrbAt(clientX, clientY);
    if (!nodeId) return false;
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    const pw = primaryWeight(node.kind, node.params);
    const param = primaryParamId(node.kind, node.params);
    if (!pw || pw.max <= pw.min || !param) return false; // weightless / derived-mean orb: no dial
    const orbCenter = orbWorldCenter(node);
    const center = worldToScreen(orbCenter);
    if (!center) return false;
    // Approximate the ring's screen radius from a surface point offset from center.
    const surf = worldToScreen({ x: orbCenter.x + ORB_RADIUS, y: orbCenter.y, z: orbCenter.z });
    const screenRadius = surf ? Math.hypot(surf.x - center.x, surf.y - center.y) : ORB_RADIUS;
    const band = { inner: RING_BAND.inner + screenRadius * 0.18, outer: RING_BAND.outer + screenRadius * 0.18 };
    if (hitRingBand(center.x, center.y, clientX, clientY, screenRadius, band) !== 'ring') return false;
    ringDragRef.current = { nodeId, param, min: pw.min, max: pw.max, cx: center.x, cy: center.y };
    // Set the value immediately from the press angle.
    updateParam(nodeId, param, angleToValue(pointerAngle(center.x, center.y, clientX, clientY), pw.min, pw.max));
    return true;
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (!isBackgroundTarget(e.target)) return;
    if (e.button !== 0 && e.button !== 1) return;
    // v0.16 overlays claim the press FIRST (before orbit/expand): a ghost sphere
    // drag flies the ghost through the field; an orb's equatorial ring band turns
    // the value dial. Both are left-button only; neither disturbs camera control.
    if (e.button === 0) {
      const ghostId = tryPickGhostAt(e.clientX, e.clientY);
      if (ghostId) {
        const ghost = ghosts.find((g) => g.id === ghostId);
        const node = ghost ? workflow.nodes.find((n) => n.id === ghost.nodeId) : undefined;
        if (ghost && node) {
          ghostDragRef.current = {
            id: ghostId,
            nodeId: ghost.nodeId,
            planeZ: ghostWorldCenter(ghost).z,
            shift: e.shiftKey,
            shiftStartY: e.clientY,
            shiftStartFieldY: ghost.pos.y,
          };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          return;
        }
      }
      if (tryStartRingDrag(e.clientX, e.clientY)) {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }
    selectNode(null);
    interactionRef.current = {
      mode: e.button === 1 || e.shiftKey ? 'pan' : 'orbit',
      x: e.clientX,
      y: e.clientY,
      moved: 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // Ring dial: turn the pointer angle around the orb center into the primary
    // value across its range (0deg=min .. ~360deg=max), writing it live.
    const ring = ringDragRef.current;
    if (ring) {
      updateParam(ring.nodeId, ring.param, angleToValue(pointerAngle(ring.cx, ring.cy, e.clientX, e.clientY), ring.min, ring.max));
      return;
    }
    // Ghost drag: ground-plane pointer sets X/Z; Shift-drag sets Y (height). The
    // dragged world pos is normalized to the field's [0,1] space, then moveGhost
    // writes the node params through applyField in one commit.
    const gd = ghostDragRef.current;
    if (gd) {
      const ghost = ghosts.find((g) => g.id === gd.id);
      const node = ghost ? workflow.nodes.find((n) => n.id === gd.nodeId) : undefined;
      if (ghost && node) {
        const origin = orbWorldCenter(node);
        if (e.shiftKey || gd.shift) {
          // Vertical Shift-drag maps screen-y delta to field Y (up = higher).
          const dyPx = gd.shiftStartY - e.clientY; // up is positive
          const nextY = clamp(gd.shiftStartFieldY + dyPx / GHOST_SHIFT_PX_PER_AXIS, 0, 1);
          const nextPos = { ...ghost.pos, y: nextY };
          moveGhost(gd.id, nextPos);
          streamPreview(nextPos); // debounced low-res preview (no-op unless armed)
        } else {
          const p = workflowPointAt(e.clientX, e.clientY, gd.planeZ);
          if (p) {
            const w = worldFromCanvas(p, gd.planeZ);
            const pos = worldToFieldPos({ x: w.x, y: origin.y, z: w.z }, origin);
            const nextPos = { x: pos.x, y: ghost.pos.y, z: pos.z };
            moveGhost(gd.id, nextPos);
            streamPreview(nextPos); // debounced low-res preview (no-op unless armed)
          }
        }
      }
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      const p = workflowPointAt(e.clientX, e.clientY, drag.planeZ);
      if (p) moveNodeTo(drag.nodeId, Math.round(p.x - drag.offsetX), Math.round(p.y - drag.offsetY));
      return;
    }
    if (wire) {
      const fromNode = workflow.nodes.find((n) => n.id === wire.fromNode);
      if (fromNode) {
        const planeZ = zFromNode(fromNode.x) + (fromNode.id === selectedNodeId ? LIFT : 0);
        const p = workflowPointAt(e.clientX, e.clientY, planeZ);
        if (p) setWire({ ...wire, cursor: p });
      }
      return;
    }
    const act = interactionRef.current;
    if (!act) return;
    const dx = e.clientX - act.x;
    const dy = e.clientY - act.y;
    act.x = e.clientX;
    act.y = e.clientY;
    act.moved += Math.abs(dx) + Math.abs(dy);
    const t = threeRef.current;
    const cam = camRef.current;
    if (act.mode === 'pan' && t) {
      const k = cam.dist * PAN_SPEED;
      const right = new THREE.Vector3().setFromMatrixColumn(t.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(t.camera.matrix, 1);
      cam.tx += -dx * k * right.x + dy * k * up.x;
      cam.ty += -dx * k * right.y + dy * k * up.y;
      cam.tz += -dx * k * right.z + dy * k * up.z;
    } else {
      cam.theta -= dx * ORBIT_SPEED;
      cam.phi = Math.min(PHI_MAX, Math.max(PHI_MIN, cam.phi - dy * ORBIT_SPEED));
    }
    applyCamera();
  };

  const onBgPointerUp = (e: React.PointerEvent) => {
    // End a ring-dial / ghost drag first (they own the press exclusively).
    if (ringDragRef.current || ghostDragRef.current) {
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      const gd = ghostDragRef.current;
      ringDragRef.current = null;
      ghostDragRef.current = null;
      // A ghost drag ended: settle the streaming preview on the resting spot.
      if (gd) {
        const g = useStudio.getState().field.ghosts.find((x) => x.id === gd.id);
        if (g) endStreamPreview(g.pos);
        else previewDebouncerRef.current?.cancel();
      }
      return;
    }
    const act = interactionRef.current;
    // A press+release on empty space without movement is a click: first try an
    // anchor marker (click = restore the ghost to that saved spot), then the
    // orbs (click = expand into the editor card), then fall back to the wire
    // lines (forgiving threshold) and disconnect a hit, exactly like the 2D
    // editor's click-on-wire behavior.
    if (act && act.moved < CLICK_SLOP) {
      const anchorId = tryPickAnchorAt(e.clientX, e.clientY);
      if (anchorId) {
        // Plain click restores the saved sweet-spot; Shift+click deletes it.
        if (e.shiftKey) deleteAnchor(anchorId);
        else restoreAnchor(anchorId);
      } else {
        const orbNodeId = tryPickOrbAt(e.clientX, e.clientY);
        if (orbNodeId) expandNode(orbNodeId);
        else tryDisconnectAt(e.clientX, e.clientY);
      }
    }
    if (act) {
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    }
    interactionRef.current = null;
    dragRef.current = null;
    setWire(null);
  };

  const endInteractions = () => {
    interactionRef.current = null;
    dragRef.current = null;
    ringDragRef.current = null;
    ghostDragRef.current = null;
    // Pointer left the viewport mid-drag: drop any pending streaming preview.
    previewDebouncerRef.current?.cancel();
    setWire(null);
  };

  // ---- palette -------------------------------------------------------------
  const addAtCenter = (kind: CapsuleKind) => {
    const cam = camRef.current;
    const c = canvasFromWorld(cam.tx, cam.ty);
    addCapsule(kind, Math.round(c.x - NODE_WIDTH / 2), Math.round(c.y - 60));
  };

  const paletteKinds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CAPSULE_KINDS.filter((kind) => {
      const def = CAPSULES[kind];
      if (category !== 'all' && def.category !== category) return false;
      if (!q) return true;
      return `${def.title} ${def.description} ${def.category} ${kind}`.toLowerCase().includes(q);
    });
  }, [category, query]);

  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId);
  /** Node ids that already have a ghost (one per node) — for the orb spawn button. */
  const ghostNodeIds = useMemo(() => new Set(ghosts.map((g) => g.nodeId)), [ghosts]);

  return (
    <div
      className="graph3d-wrap"
      aria-label="3D Graph View"
      onPointerDown={onBgPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onBgPointerUp}
      onPointerLeave={endInteractions}
    >
      <div ref={viewportRef} className="graph3d-viewport" />

      {showDiagnostics && <div className="graph3d-stats" ref={statsElRef} aria-hidden="true" />}

      <CollapsiblePalette>
        <div className="graph-palette-head">
          <strong>Nodes</strong>
          <span>{paletteKinds.length}/{CAPSULE_KINDS.length}</span>
        </div>
        <div className="graph-palette-controls">
          <input
            className="graph-palette-search"
            value={query}
            placeholder="Search nodes"
            aria-label="Search nodes"
            onChange={(event) => setQuery(event.target.value)}
          />
          <select className="graph-category-select" value={category} aria-label="Node category"
            onChange={(event) => setCategory(event.target.value as 'all' | CapsuleCategory)}>
            {CATEGORY_FILTERS.map((item) => (
              <option key={item} value={item}>{item === 'all' ? 'All' : CAPSULE_CATEGORY_LABELS[item]}</option>
            ))}
          </select>
        </div>
        <div className="graph-palette-list" aria-label="Node palette">
          {paletteKinds.map((kind) => (
            <button key={kind} className="btn graph-node-option" type="button" onClick={() => addAtCenter(kind)} title={`Add ${CAPSULES[kind].title}`}>
              <CapsuleIcon kind={kind} size={14} />
              <span>{CAPSULES[kind].title}</span>
              <small>{CAPSULE_CATEGORY_LABELS[CAPSULES[kind].category]}</small>
            </button>
          ))}
        </div>
        <div className="graph-toolbar-sep" />
        <button
          className="btn"
          type="button"
          aria-pressed={graph3dStyle === 'orbs'}
          onClick={() => updateAppSettings({ graph3dStyle: graph3dStyle === 'orbs' ? 'cards' : 'orbs' })}
          title={graph3dStyle === 'orbs'
            ? 'Showing gradient orbs — switch to full cards'
            : 'Showing full cards — switch to gradient orbs'}
        >
          Orbs ⇄ Cards
        </button>
        <button
          className="btn"
          type="button"
          aria-pressed={graph3dEffects !== 'off'}
          onClick={() => updateAppSettings({
            graph3dEffects:
              graph3dEffects === 'off' ? 'standard'
              : graph3dEffects === 'minimal' ? 'standard'
              : graph3dEffects === 'standard' ? 'rich'
              : graph3dEffects === 'rich' ? 'cinematic'
              : 'off',
          })}
          title={graph3dEffects === 'off'
            ? 'Spacetime off — click for the liquid-metal fabric + energy flow'
            : graph3dEffects === 'minimal'
              ? 'Fabric only — click for gravity dust + energy pulses'
              : graph3dEffects === 'standard'
                ? 'Fabric + dust + pulses on — click for dense dust and stars'
                : graph3dEffects === 'rich'
                  ? 'Rich spacetime on — click for the cinematic bloom pipeline'
                  : 'Cinematic pipeline on — click to turn everything off'}
        >
          Spacetime {graph3dEffects === 'off' ? 'Off'
            : graph3dEffects === 'minimal' ? 'Low'
            : graph3dEffects === 'standard' ? 'On'
            : graph3dEffects === 'rich' ? 'Rich'
            : 'Cinematic'}
        </button>
        <button className="btn" type="button" disabled={!selectedNode} onClick={() => selectedNode && duplicateCapsule(selectedNode.id)} title="Duplicate selected node">
          Duplicate
        </button>
        <button className="btn" type="button" disabled={!selectedNode} onClick={() => selectedNode && removeCapsule(selectedNode.id)} title="Delete selected node">
          Delete
        </button>
        <button className="btn" type="button" onClick={() => { autoLayoutGraph(); requestAnimationFrame(fitCamera); }} title="Auto-layout graph">
          Auto-layout
        </button>
        <button className="btn" type="button" onClick={resetCamera} title="Reset camera">
          Reset camera
        </button>
        <button className="btn" type="button" onClick={fitCamera} title="Frame all nodes">
          Fit
        </button>
      </CollapsiblePalette>

      <div className="graph-hint">
        Drag headers to move | drag space to orbit | shift-drag to pan | scroll to dolly | click a wire to remove |
        {' '}{workflow.nodes.length} capsules, {workflow.edges.length} links
      </div>

      {workflow.nodes.map((node) => {
        const { ok, bad } = candidateFor(node.id);
        // 'orbs' style: non-selected nodes are gradient spheres (WebGL) with a
        // small label chip; the SELECTED node keeps the full v0.12 editor card
        // (CSS3D, in place) — that IS the expand-on-focus behavior.
        return createPortal(
          isOrbNode(node) ? (
            <OrbChip
              node={node}
              summary={nodeSummary(node.kind, node.params)}
              onSelect={() => expandNode(node.id)}
              onKeyDown={onNodeKey(node.id)}
              onPortDown={onPortDown(node.id)}
              onPortUp={onPortUp(node.id)}
              candidatePorts={ok}
              invalidPorts={bad}
              onSpawnGhost={() => spawnGhost(node.id)}
              ghostDisabledReason={hasProfile(node.id) ? null : 'This node has no numeric params to control in 3D'}
              hasGhost={ghostNodeIds.has(node.id)}
            />
          ) : (
            <GraphNode
              node={node}
              selected={selectedNodeId === node.id}
              summary={nodeSummary(node.kind, node.params)}
              onPointerDownHead={onHeadDown(node.id)}
              onSelect={() => selectNode(node.id)}
              onKeyDown={onNodeKey(node.id)}
              onPortDown={onPortDown(node.id)}
              onPortUp={onPortUp(node.id)}
              candidatePorts={ok}
              invalidPorts={bad}
            />
          ),
          getAnchor(node.id),
          node.id,
        );
      })}

      {/* Ghost controller chips (v0.16): each rides a CSS3DObject at its ghost's
          world center. Rendered here (portaled into the ghost's zero-size CSS3D
          anchor) so React owns the DOM while three positions it. */}
      {ghosts.map((ghost) => {
        const node = workflow.nodes.find((n) => n.id === ghost.nodeId);
        if (!node) return null;
        const profile = profileFor(ghost.nodeId);
        const patches = applyField(ghost.pos, ghost.intensity, profile, ghost.nodeId);
        return createPortal(
          <GhostChip
            ghostId={ghost.id}
            node={node}
            profile={profile}
            intensity={ghost.intensity}
            pinned={ghost.pinned}
            recording={ghost.recording}
            patches={patches}
            onIntensity={(v) => setGhostIntensity(ghost.id, v)}
            onPin={() => pinGhost(ghost.id)}
            onSaveAnchor={(name) => saveAnchor(ghost.id, name)}
            onRecordToggle={() => (ghost.recording ? stopGhostRecording(ghost.id) : startGhostRecording(ghost.id))}
            onCollapse={() => collapseGhost(ghost.id)}
            onNudge={(axis, delta) => moveGhost(ghost.id, nudgeFieldPos(ghost.pos, axis, delta))}
          />,
          getGhostChipAnchor(ghost.id),
          ghost.id,
        );
      })}

      {/* Honest one-line note: how the controller maps to values, and that the
          field is curated (deterministic), not a trained/learned model. */}
      <div className="graph3d-ghost-note" aria-live="polite">
        Ghost drives values by position; ring = value; intensity = ghost slider. Curated field, not a trained model.
      </div>

      {/* Motion Timeline overlay — collapsible bottom dock. Rendered inside the
          3D workspace (where the playback rAF lives) so Play choreographs the
          orbs directly. Stops pointer events from reaching the orbit handler. */}
      <div
        className={`motion-panel ${motionPanelOpen ? 'open' : 'collapsed'}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="motion-panel-tab"
          aria-expanded={motionPanelOpen}
          aria-controls="graph-motion-body"
          title={motionPanelOpen ? 'Hide the motion timeline' : 'Show the motion timeline'}
          onClick={() => setMotionPanelOpen((v) => !v)}
        >
          {Icon.pulse({ size: 14 })}
          <span>Motion</span>
        </button>
        {motionPanelOpen ? (
          <div id="graph-motion-body" className="motion-panel-body scroll">
            <MotionTimeline />
            <FieldPresetsPanel />
            <StreamingPreview />
            <AudioPanel />
            <EvolvePanel />
          </div>
        ) : null}
      </div>
    </div>
  );
}
