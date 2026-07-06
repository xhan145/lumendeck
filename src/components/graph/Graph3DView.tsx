import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { CAPSULES, CAPSULE_CATEGORY_LABELS, CAPSULE_KINDS } from '../../core/capsules';
import { canConnect } from '../../core/workflow';
import type { CapsuleCategory, CapsuleKind, SocketDef, SocketType } from '../../core/types';
import { useStudio } from '../../state/store';
import { CapsuleIcon } from '../icons';
import { CollapsiblePalette } from './CollapsiblePalette';
import { GraphNode } from './GraphNode';
import { OrbChip } from './OrbChip';
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
import { gradientStops, weightT } from './graph3d/orbWeight';
import {
  buildNeonGrid,
  disposeObject3D,
  makeOrbGeometry,
  makeOrbMaterial,
  makeOrbRing,
  makeWireLine,
  resolveCssColor,
  updateOrbMaterial,
  updateWireLine,
} from './graph3d/scene';

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
}

/** Gradient stops for weightless kinds: a neutral slate orb. */
const NEUTRAL_ORB_STOPS: [string, string, string] = ['#42526b', '#5c6d87', '#7b8ca6'];

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
  return !el.closest('.gnode, .orb-chip, .collapsible-palette, .graph-toolbar, .graph-hint, .graph-mode-toggle, .graph3d-note');
}

export function Graph3DView({ onContextFailed }: Props) {
  const workflow = useStudio((s) => s.workflow);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);
  const graph3dStyle = useStudio((s) => s.appSettings.graph3dStyle ?? 'orbs');
  const updateAppSettings = useStudio((s) => s.updateAppSettings);
  const selectNode = useStudio((s) => s.selectNode);
  const moveNodeTo = useStudio((s) => s.moveNodeTo);
  const connectSockets = useStudio((s) => s.connectSockets);
  const disconnectEdge = useStudio((s) => s.disconnectEdge);
  const addCapsule = useStudio((s) => s.addCapsule);
  const duplicateCapsule = useStudio((s) => s.duplicateCapsule);
  const autoLayoutGraph = useStudio((s) => s.autoLayoutGraph);
  const removeCapsule = useStudio((s) => s.removeCapsule);

  const viewportRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<ThreeCtx | null>(null);
  const rafRef = useRef<number | null>(null);
  const camRef = useRef<CamState>({ tx: 0, ty: 0, tz: 0, ...DEFAULT_CAM });
  const anchorsRef = useRef(new Map<string, HTMLDivElement>());
  const orbsRef = useRef(new Map<string, OrbEntry>());
  const colorCacheRef = useRef(new Map<SocketType, string>());
  const accentCacheRef = useRef(new Map<CapsuleKind, string>());
  const dragRef = useRef<DragState | null>(null);
  const interactionRef = useRef<{ mode: 'orbit' | 'pan'; x: number; y: number; moved: number } | null>(null);
  const onContextFailedRef = useRef(onContextFailed);
  onContextFailedRef.current = onContextFailed;

  const [ready, setReady] = useState(false);
  const [wire, setWire] = useState<WireDraft | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | CapsuleCategory>('all');

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

  /** Dirty-flag render: one rAF per invalidation, no continuous loop when idle. */
  const requestRender = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const t = threeRef.current;
      if (!t) return;
      t.renderer.render(t.scene, t.camera);
      t.cssRenderer.render(t.scene, t.camera);
    });
  }, []);

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
      const orbGeometry = makeOrbGeometry(ORB_RADIUS);

      const raycaster = new THREE.Raycaster();
      raycaster.params.Line = { threshold: 6 };

      host.appendChild(renderer.domElement);
      host.appendChild(cssRenderer.domElement);
      threeRef.current = { renderer, cssRenderer, scene, camera, wireGroup, orbGroup, orbGeometry, nodeObjects: new Map(), draftLine: null, raycaster };

      // Pre-resolve every socket color once (bug guard: THREE.Color must never
      // see a raw var() token, and sync effects must not hit getComputedStyle).
      for (const type of ALL_SOCKET_TYPES) wireColor(type);

      const resize = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w < 1 || h < 1) return;
        renderer.setSize(w, h);
        cssRenderer!.setSize(w, h);
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
        ro?.disconnect();
        host.removeEventListener('wheel', onWheel);
        host.removeEventListener('scroll', resetScroll, true);
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        orbsRef.current.clear();
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
          entry = { group, material, ring: null, ringT: -1, tintKey };
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
      orbs.delete(id);
    }
    requestRender();
  }, [ready, workflow, selectedNodeId, graph3dStyle, capsuleAccent, requestRender]);

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
      const line = existing.get(edge.id);
      if (line) {
        updateWireLine(line, a, b); // an edge's socket (and thus color) never changes
      } else {
        const type = CAPSULES[fromNode.kind].outputs.find((s) => s.id === edge.from.socket)?.type ?? 'image';
        const created = makeWireLine(a, b, wireColor(type));
        created.userData.edgeId = edge.id;
        t.wireGroup.add(created);
      }
      seen.add(edge.id);
    }
    for (const [id, line] of existing) {
      if (seen.has(id)) continue;
      t.wireGroup.remove(line);
      disposeObject3D(line);
    }
    requestRender();
  }, [ready, workflow, selectedNodeId, isOrbNode, wireColor, requestRender]);

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

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (!isBackgroundTarget(e.target)) return;
    if (e.button !== 0 && e.button !== 1) return;
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
    const act = interactionRef.current;
    // A press+release on empty space without movement is a click: first try
    // the orbs (click = expand into the editor card), then fall back to the
    // wire lines (forgiving threshold) and disconnect a hit, exactly like the
    // 2D editor's click-on-wire behavior.
    if (act && act.moved < CLICK_SLOP) {
      const orbNodeId = tryPickOrbAt(e.clientX, e.clientY);
      if (orbNodeId) expandNode(orbNodeId);
      else tryDisconnectAt(e.clientX, e.clientY);
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
    </div>
  );
}
