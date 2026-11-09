import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FileEntry, FileKind } from '../../bridge/files';
import { FILE_GROUPS, makeFileStars, type FileStar } from '../../core/shell/fileMap';
import { FILE_FX_PRESETS, makeFileFxGovernor } from '../../core/shell/fileFx';
import { FILE_ZOOM, fileZoomActionFromKey, nextFileZoomDistance, type FileZoomAction } from '../../core/shell/fileZoom';
import {
  FILE_TIME_DURATION_SECONDS, FILE_TIME_STEPS,
  clampTimeProgress, fileTimeAt, fileTimeBounds, projectFileThroughTime,
} from '../../core/shell/fileTime';
import type { FileFxMode } from '../../state/appSettings';
import { createPostPipeline, type PostPipeline } from '../graph/graph3d/postprocessing';
import { createFileAtmosphere } from './fileConstellationAtmosphere';

interface Props {
  entries: FileEntry[];
  selectedPath: string | null;
  folderName: string;
  folderPath: string;
  fxMode: FileFxMode;
  onSelect: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onUnavailable: () => void;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const changed = () => setReduced(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return reduced;
}

function makeLabel(text: string, color: string, size = 3.2): THREE.Sprite | null {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 88;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = '600 32px system-ui';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 44, 495);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, opacity: 0.93, depthWrite: false,
  }));
  sprite.scale.set(size, size * 88 / 512, 1);
  sprite.renderOrder = 7;
  return sprite;
}

function starVector(star: FileStar): THREE.Vector3 {
  return new THREE.Vector3(star.x, star.y, star.z);
}

/**
 * Dynamic, indexed membership wires. The rings/labels are static group
 * landmarks; their wires follow the projected star positions on every tick.
 */
function createLinks(scene: THREE.Scene, stars: FileStar[]): (xyz: Float32Array) => void {
  const groups = new Map<FileKind, number[]>();
  for (const [index, star] of stars.entries()) {
    const found = groups.get(star.group) ?? [];
    found.push(index);
    groups.set(star.group, found);
  }

  type End = { kind: 'root' } | { kind: 'center'; group: FileKind } | { kind: 'star'; index: number };
  const segments: Array<{ from: End; to: End; color: THREE.Color }> = [];
  const root: End = { kind: 'root' };

  for (const group of FILE_GROUPS) {
    const indices = groups.get(group.kind);
    if (!indices?.length) continue;
    const tint = new THREE.Color(group.color);
    const center: End = { kind: 'center', group: group.kind };
    segments.push({ from: root, to: center, color: tint });

    const ordered = [...indices].sort((a, b) =>
      stars[a].entry.path.localeCompare(stars[b].entry.path),
    );
    for (const [position, index] of ordered.entries()) {
      segments.push({ from: center, to: { kind: 'star', index }, color: tint });
      if (position > 0) {
        segments.push({
          from: { kind: 'star', index: ordered[position - 1] },
          to: { kind: 'star', index }, color: tint,
        });
      }
    }

    // The orbit ring and label identify a category, not a fabricated file.
    const centroid = new THREE.Vector3();
    for (const index of indices) centroid.add(starVector(stars[index]));
    centroid.multiplyScalar(1 / indices.length);
    const radius = 1.15 + Math.sqrt(indices.length) * 0.21;
    const ellipse: THREE.Vector3[] = [];
    for (let k = 0; k < 80; k++) {
      const angle = k * Math.PI * 2 / 80;
      ellipse.push(new THREE.Vector3(
        centroid.x + Math.cos(angle) * radius,
        centroid.y + Math.sin(angle) * radius * 0.68,
        centroid.z + Math.sin(angle * 2) * 0.27,
      ));
    }
    scene.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ellipse),
      new THREE.LineBasicMaterial({
        color: tint, transparent: true, opacity: 0.19,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    ));

    const label = makeLabel(group.label.toUpperCase(), '#d4c4ed', 3.35);
    if (label) {
      label.position.copy(centroid).add(new THREE.Vector3(0, radius * 0.86 + 0.6, 0));
      scene.add(label);
    }
  }

  if (!segments.length) return () => {};
  const positions = new Float32Array(segments.length * 6);
  const colors = new Float32Array(segments.length * 6);
  segments.forEach((segment, index) => {
    const k = index * 6;
    colors.set([
      segment.color.r, segment.color.g, segment.color.b,
      segment.color.r, segment.color.g, segment.color.b,
    ], k);
  });
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.27,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  lines.renderOrder = 0;
  lines.frustumCulled = false;
  scene.add(lines);

  return (xyz: Float32Array) => {
    const centers = new Map<FileKind, [number, number, number]>();
    for (const [kind, indices] of groups) {
      let x = 0; let y = 0; let z = 0;
      for (const index of indices) {
        x += xyz[index * 3];
        y += xyz[index * 3 + 1];
        z += xyz[index * 3 + 2];
      }
      const n = indices.length;
      centers.set(kind, [x / n, y / n, z / n]);
    }
    const get = (end: End): readonly number[] => {
      if (end.kind === 'root') return [0, 0, 0];
      if (end.kind === 'center') return centers.get(end.group) ?? [0, 0, 0];
      return [xyz[end.index * 3], xyz[end.index * 3 + 1], xyz[end.index * 3 + 2]];
    };
    for (const [i, segment] of segments.entries()) {
      const from = get(segment.from);
      const to = get(segment.to);
      positions.set([from[0], from[1], from[2], to[0], to[1], to[2]], i * 6);
    }
    attribute.needsUpdate = true;
  };
}

/**
 * Real Windows folder data becomes a stable, navigable 3D constellation.
 * The 3D presentation NEVER changes underlying filesystem paths.
 */
export function FileConstellation({
  entries, selectedPath, folderName, folderPath, fxMode, onSelect, onOpen, onUnavailable,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const savedCameraRef = useRef<{
    folderPath: string; position: THREE.Vector3; target: THREE.Vector3;
  } | null>(null);
  const focusRef = useRef<(selected: string | null, hovered: string | null) => void>(() => {});
  const zoomCommandRef = useRef<(action: FileZoomAction) => void>(() => {});
  const selectedRef = useRef(selectedPath);
  const onSelectRef = useRef(onSelect);
  const onOpenRef = useRef(onOpen);
  const onUnavailableRef = useRef(onUnavailable);
  selectedRef.current = selectedPath;
  onSelectRef.current = onSelect;
  onOpenRef.current = onOpen;
  onUnavailableRef.current = onUnavailable;

  const [hovered, setHovered] = useState<FileEntry | null>(null);
  const [degraded, setDegraded] = useState(false);
  const hoverRef = useRef<string | null>(null);
  const reducedMotion = useReducedMotion();
  const stars = useMemo(() => makeFileStars(entries), [entries]);

  const temporalBounds = useMemo(
    () => fileTimeBounds(stars.map((star) => star.entry)),
    [stars],
  );
  // The playhead stays in a ref so 60 FPS star motion never re-mounts WebGL.
  const [timeEnabled, setTimeEnabled] = useState(true);
  const [timePlaying, setTimePlaying] = useState(true);
  const [timePosition, setTimePosition] = useState(0);
  const timeEnabledRef = useRef(true);
  const timePlayingRef = useRef(true);
  const timePositionRef = useRef(0);
  const projectTimeRef = useRef<() => void>(() => {});

  const showTimePosition = (progress: number) => {
    const clamped = clampTimeProgress(progress);
    timePositionRef.current = clamped;
    setTimePosition(clamped);
    projectTimeRef.current();
  };
  const pauseTime = () => {
    timePlayingRef.current = false;
    setTimePlaying(false);
  };
  const scrubTime = (progress: number) => {
    pauseTime();
    showTimePosition(progress);
  };
  const toggleTime = (enabled: boolean) => {
    timeEnabledRef.current = enabled;
    setTimeEnabled(enabled);
    if (!enabled) pauseTime();
    projectTimeRef.current();
  };
  const togglePlay = () => {
    if (!timeEnabledRef.current || !temporalBounds?.distinctDates || reducedMotion) return;
    timePlayingRef.current = !timePlayingRef.current;
    setTimePlaying(timePlayingRef.current);
    if (timePlayingRef.current && timePositionRef.current >= 0.999) {
      showTimePosition(0);
    }
  };
  useEffect(() => {
    timePositionRef.current = 0;
    setTimePosition(0);
    projectTimeRef.current();
  }, [folderPath, temporalBounds?.firstMs, temporalBounds?.lastMs]);
  useEffect(() => {
    if (reducedMotion) {
      timePlayingRef.current = false;
      setTimePlaying(false);
    }
  }, [reducedMotion]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setDegraded(false);
    setHovered(null);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: false, antialias: true, powerPreference: 'high-performance',
      });
    } catch {
      onUnavailableRef.current();
      return;
    }

    const preset = FILE_FX_PRESETS[fxMode];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#090a17');
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 190);
    camera.position.set(0, 1, FILE_ZOOM.initialDistance);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.minDistance = FILE_ZOOM.minDistance;
    controls.maxDistance = FILE_ZOOM.maxDistance;
    controls.zoomSpeed = FILE_ZOOM.wheelSpeed;
    controls.zoomToCursor = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 0);
    const priorCamera = savedCameraRef.current;
    if (priorCamera?.folderPath === folderPath) {
      camera.position.copy(priorCamera.position);
      controls.target.copy(priorCamera.target);
      controls.update();
    }

    const nativePixelRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatioCap);
    renderer.setPixelRatio(nativePixelRatio);
    renderer.setClearColor('#090a17', 1);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.style.touchAction = 'none';
    host.appendChild(renderer.domElement);

    const atmosphere = createFileAtmosphere(scene, stars, preset);
    atmosphere.setPixelRatio(nativePixelRatio);

    const root = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 24, 16),
      new THREE.MeshBasicMaterial({ color: '#dfd1ff', toneMapped: false }),
    );
    scene.add(root);
    const nucleusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.63, 0.67, 80),
      new THREE.MeshBasicMaterial({
        color: '#ae91ef', transparent: true, opacity: 0.52,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    scene.add(nucleusRing);

    const rootLabel = makeLabel(folderName.slice(0, 31), '#f1eaff', 4.45);
    if (rootLabel) {
      rootLabel.position.set(0, -1.05, 0);
      scene.add(rootLabel);
    }

    const updateLinks = createLinks(scene, stars);

    // One instanced GPU draw for all selectable file cores.
    const sphere = new THREE.SphereGeometry(1, 12, 9);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff', toneMapped: false,
    });
    const cores = new THREE.InstancedMesh(sphere, coreMaterial, stars.length);
    cores.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const unit = new THREE.Object3D();
    const tint = new THREE.Color();
    const byPath = new Map(stars.map((star, index) => [star.entry.path, index]));
    const currentXYZ = new Float32Array(stars.length * 3);
    const laterModified = new Uint8Array(stars.length);
    stars.forEach((star, index) => {
      currentXYZ.set([star.x, star.y, star.z], index * 3);
      unit.position.set(star.x, star.y, star.z);
      unit.scale.setScalar(star.entry.isDirectory ? 0.32 : 0.21);
      unit.updateMatrix();
      cores.setMatrixAt(index, unit.matrix);
      cores.setColorAt(index, tint.set(star.color));
    });
    cores.instanceMatrix.needsUpdate = true;
    if (cores.instanceColor) cores.instanceColor.needsUpdate = true;
    cores.computeBoundingSphere();
    scene.add(cores);

    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.46, 72),
      new THREE.MeshBasicMaterial({
        color: '#e7d9ff', transparent: true, opacity: 0.86,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    reticle.visible = false;
    reticle.renderOrder = 5;
    scene.add(reticle);
    const reticleOuter = new THREE.Mesh(
      new THREE.RingGeometry(0.56, 0.575, 72),
      new THREE.MeshBasicMaterial({
        color: '#bca8ed', transparent: true, opacity: 0.52,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    reticleOuter.visible = false;
    reticleOuter.renderOrder = 5;
    scene.add(reticleOuter);
    const beamData = new Float32Array(6);
    const beamAttribute = new THREE.BufferAttribute(beamData, 3);
    beamAttribute.setUsage(THREE.DynamicDrawUsage);
    const beamGeometry = new THREE.BufferGeometry();
    beamGeometry.setAttribute('position', beamAttribute);
    const activeBeam = new THREE.Line(
      beamGeometry,
      new THREE.LineBasicMaterial({
        color: '#d9c9ff', transparent: true, opacity: 0.66,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    activeBeam.visible = false;
    activeBeam.frustumCulled = false;
    scene.add(activeBeam);

    // The selected star gets an abstract trajectory through the modeled time
    // dimension. This is NOT a real historical file location.
    const trailCount = 30;
    const trailData = new Float32Array(trailCount * 3);
    const trailAttribute = new THREE.BufferAttribute(trailData, 3);
    trailAttribute.setUsage(THREE.DynamicDrawUsage);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', trailAttribute);
    const temporalTrail = new THREE.Line(
      trailGeometry,
      new THREE.LineBasicMaterial({
        color: '#b79be7', transparent: true, opacity: 0.54,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    temporalTrail.visible = false;
    temporalTrail.frustumCulled = false;
    temporalTrail.renderOrder = 2;
    scene.add(temporalTrail);

    const applyFocus = (selected: string | null, hoveredPath: string | null) => {
      for (const [index, star] of stars.entries()) {
        const focused = star.entry.path === selected;
        const isHover = star.entry.path === hoveredPath && !focused;
        unit.position.set(currentXYZ[index * 3], currentXYZ[index * 3 + 1], currentXYZ[index * 3 + 2]);
        unit.scale.setScalar((star.entry.isDirectory ? 0.32 : 0.21) *
          (focused ? 1.36 : isHover ? 1.18 : 1));
        unit.updateMatrix();
        cores.setMatrixAt(index, unit.matrix);
        tint.set(focused ? '#ffffff' : star.color);
        if (!focused && laterModified[index]) tint.multiplyScalar(0.38);
        cores.setColorAt(index, tint);
      }
      cores.instanceMatrix.needsUpdate = true;
      if (cores.instanceColor) cores.instanceColor.needsUpdate = true;
      cores.computeBoundingSphere();
      atmosphere.setFocus(selected, hoveredPath);

      const index = selected ? byPath.get(selected) : undefined;
      const item = index === undefined ? null : stars[index];
      reticle.visible = !!item;
      reticleOuter.visible = !!item;
      activeBeam.visible = !!item;
      if (item && index !== undefined) {
        const k = index * 3;
        reticle.position.set(currentXYZ[k], currentXYZ[k + 1], currentXYZ[k + 2]);
        reticleOuter.position.copy(reticle.position);
        beamAttribute.setXYZ(0, 0, 0, 0);
        beamAttribute.setXYZ(1, currentXYZ[k], currentXYZ[k + 1], currentXYZ[k + 2]);
        beamAttribute.needsUpdate = true;
      }
    };
    focusRef.current = applyFocus;

    const projectTime = () => {
      const enabled = timeEnabledRef.current && temporalBounds?.distinctDates;
      const progress = timePositionRef.current;
      for (const [index, star] of stars.entries()) {
        const point = enabled ? projectFileThroughTime(star, temporalBounds, progress)
          : { x: star.x, y: star.y, z: star.z, laterModified: false };
        currentXYZ.set([point.x, point.y, point.z], index * 3);
        laterModified[index] = point.laterModified ? 1 : 0;
      }
      atmosphere.moveStars(currentXYZ);
      updateLinks(currentXYZ);
      applyFocus(selectedRef.current, hoverRef.current);

      const index = selectedRef.current ? byPath.get(selectedRef.current) : undefined;
      temporalTrail.visible = !!enabled && index !== undefined;
      if (enabled && index !== undefined) {
        const star = stars[index];
        const from = Math.max(0, progress - 0.23);
        for (let i = 0; i < trailCount; i++) {
          const p = from + (progress - from) * i / (trailCount - 1);
          const point = projectFileThroughTime(star, temporalBounds, p);
          trailAttribute.setXYZ(i, point.x, point.y, point.z);
        }
        trailAttribute.needsUpdate = true;
      }
    };
    projectTimeRef.current = projectTime;
    projectTime();

    // Camera navigation is separate from file selection: zoom never moves files
    // or reconstructs the 3D scene. Repeated button presses accumulate even
    // while a previous camera flight is still animating.
    type CameraFlight = {
      fromPosition: THREE.Vector3;
      fromTarget: THREE.Vector3;
      toPosition: THREE.Vector3;
      toTarget: THREE.Vector3;
      startedAt: number | null;
    };
    let flight: CameraFlight | null = null;
    const animateCamera = (position: THREE.Vector3, target: THREE.Vector3) => {
      if (reducedMotion) {
        flight = null;
        camera.position.copy(position);
        controls.target.copy(target);
        controls.update();
        return;
      }
      flight = {
        fromPosition: camera.position.clone(),
        fromTarget: controls.target.clone(),
        toPosition: position,
        toTarget: target,
        startedAt: null,
      };
    };
    const commandZoom = (action: FileZoomAction) => {
      if (action === 'reset') {
        animateCamera(
          new THREE.Vector3(0, 1, FILE_ZOOM.initialDistance),
          new THREE.Vector3(0, 0, 0),
        );
        return;
      }
      if (action === 'focus') {
        const index = selectedRef.current ? byPath.get(selectedRef.current) : undefined;
        if (index === undefined) return;
        const k = index * 3;
        const point = new THREE.Vector3(currentXYZ[k], currentXYZ[k + 1], currentXYZ[k + 2]);
        const direction = camera.position.clone().sub(controls.target);
        if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1);
        direction.normalize().multiplyScalar(FILE_ZOOM.focusDistance);
        animateCamera(point.clone().add(direction), point);
        return;
      }
      const target = flight?.toTarget.clone() ?? controls.target.clone();
      const position = flight?.toPosition.clone() ?? camera.position.clone();
      const offset = position.sub(target);
      const distance = offset.length();
      const factor = action === 'in' ? FILE_ZOOM.buttonFactor : 1 / FILE_ZOOM.buttonFactor;
      const nextDistance = nextFileZoomDistance(distance, factor);
      if (Math.abs(nextDistance - distance) < 0.0001) return;
      if (distance < 0.0001) offset.set(0, 0, 1);
      animateCamera(
        target.clone().add(offset.normalize().multiplyScalar(nextDistance)),
        target,
      );
    };
    zoomCommandRef.current = commandZoom;
    // Drag, wheel and pinch always take priority over an automated flight.
    const cancelFlight = () => { flight = null; };
    controls.addEventListener('start', cancelFlight);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (event: MouseEvent | PointerEvent): FileEntry | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1;
      pointer.y = -(event.clientY - rect.top) / rect.height * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(cores, false)[0];
      const index = hit?.instanceId;
      return index === undefined ? null : stars[index]?.entry ?? null;
    };

    let pointerDown: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
    };
    const move = (event: PointerEvent) => {
      if (event.buttons) return;
      const item = pick(event);
      const key = item?.path ?? null;
      if (key === hoverRef.current) return;
      hoverRef.current = key;
      renderer.domElement.style.cursor = key ? 'pointer' : 'grab';
      setHovered(item);
      applyFocus(selectedRef.current, key);
    };
    const leave = () => {
      hoverRef.current = null;
      setHovered(null);
      renderer.domElement.style.cursor = 'grab';
      applyFocus(selectedRef.current, null);
    };
    const click = (event: MouseEvent) => {
      if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 7) return;
      const entry = pick(event);
      if (entry) onSelectRef.current(entry);
    };
    const doubleClick = (event: MouseEvent) => {
      const entry = pick(event);
      if (entry) onOpenRef.current(entry);
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerleave', leave);
    renderer.domElement.addEventListener('click', click);
    renderer.domElement.addEventListener('dblclick', doubleClick);

    let pipeline: PostPipeline | null = null;
    let reducedEffects = false;
    if (preset.bloom) {
      try {
        pipeline = createPostPipeline(renderer, scene, camera, {
          strength: preset.bloomStrength,
          threshold: 0.78,
          radius: 0.48,
        });
      } catch {
        // Unsupported GPU post-processing is cosmetic, not a fatal browser error.
        reducedEffects = true;
        setDegraded(true);
      }
    }

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      pipeline?.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const governor = makeFileFxGovernor();
    let request = 0;
    let lastFrame = 0;
    let lastRendered = 0;
    let lastTimeLabel = 0;
    let startTime = 0;
    const frame = (now: number) => {
      try {
        // Reduced-motion mode redraws at a lower cadence while preserving
        // file selection and orbit interaction.
        if (reducedMotion && lastRendered && now - lastRendered < 40) {
          request = requestAnimationFrame(frame);
          return;
        }
        lastRendered = now;
        if (!startTime) startTime = now;
        const elapsed = reducedMotion ? 0 : (now - startTime) / 1000;
        const frameDuration = lastFrame ? now - lastFrame : 16;
        lastFrame = now;
        if (timeEnabledRef.current && timePlayingRef.current &&
            temporalBounds?.distinctDates && !reducedMotion) {
          const fraction = Math.max(0, Math.min(frameDuration, 70)) /
            (FILE_TIME_DURATION_SECONDS * 1000);
          timePositionRef.current = (timePositionRef.current + fraction) % 1;
          projectTime();
          // Only the slider/date label updates through React. Mesh motion
          // remains on the renderer's own rAF, without React tree churn.
          if (now - lastTimeLabel >= 120) {
            lastTimeLabel = now;
            setTimePosition(timePositionRef.current);
          }
        }
        if (flight) {
          if (flight.startedAt === null) flight.startedAt = now;
          const progress = Math.min(1, (now - flight.startedAt) / FILE_ZOOM.transitionMs);
          const eased = 1 - Math.pow(1 - progress, 3);
          camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
          controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
          if (progress >= 1) flight = null;
        }
        controls.update();
        atmosphere.update(elapsed, !reducedMotion && fxMode !== 'off');
        nucleusRing.quaternion.copy(camera.quaternion);
        if (reticle.visible) {
          reticle.quaternion.copy(camera.quaternion);
          reticleOuter.quaternion.copy(camera.quaternion);
          const pulse = reducedMotion ? 1 : 1 + 0.09 * Math.sin(elapsed * 2.3);
          reticle.scale.setScalar(pulse);
          reticleOuter.scale.setScalar(reducedMotion ? 1 : 1 + 0.14 * Math.sin(elapsed * 1.4 + 1));
          (activeBeam.material as THREE.LineBasicMaterial).opacity =
            reducedMotion ? 0.62 : 0.52 + 0.13 * Math.sin(elapsed * 1.7);
        }
        if (pipeline && !reducedEffects) pipeline.render();
        else renderer.render(scene, camera);

        if (!reducedMotion && !reducedEffects && governor.feed(frameDuration)) {
          reducedEffects = true;
          renderer.setPixelRatio(Math.min(1, window.devicePixelRatio || 1));
          atmosphere.setPixelRatio(renderer.getPixelRatio());
          resize();
          setDegraded(true);
        }
        request = requestAnimationFrame(frame);
      } catch {
        // If bloom fails, attempt direct rendering before giving up on 3D.
        if (pipeline && !reducedEffects) {
          reducedEffects = true;
          setDegraded(true);
          request = requestAnimationFrame(frame);
        } else {
          onUnavailableRef.current();
        }
      }
    };
    const onVisibility = () => {
      cancelAnimationFrame(request);
      request = 0;
      lastFrame = 0;
      if (!document.hidden) request = requestAnimationFrame(frame);
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      onUnavailableRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    onVisibility();

    return () => {
      cancelAnimationFrame(request);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('pointerleave', leave);
      renderer.domElement.removeEventListener('click', click);
      renderer.domElement.removeEventListener('dblclick', doubleClick);
      observer.disconnect();
      controls.removeEventListener('start', cancelFlight);
      zoomCommandRef.current = () => {};
      savedCameraRef.current = {
        folderPath, position: camera.position.clone(), target: controls.target.clone(),
      };
      controls.dispose();
      focusRef.current = () => {};
      projectTimeRef.current = () => {};
      hoverRef.current = null;
      pipeline?.dispose();
      atmosphere.dispose();

      const seenGeometry = new Set<THREE.BufferGeometry>();
      const seenMaterial = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
          if (!seenGeometry.has(object.geometry)) {
            seenGeometry.add(object.geometry);
            object.geometry.dispose();
          }
        }
        const material = (object as THREE.Mesh).material as
          THREE.Material | THREE.Material[] | undefined;
        for (const item of Array.isArray(material) ? material : material ? [material] : []) {
          if (seenMaterial.has(item)) continue;
          seenMaterial.add(item);
          if (item instanceof THREE.SpriteMaterial) item.map?.dispose();
          item.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [stars, folderName, folderPath, fxMode, reducedMotion]);

  // Selection changes do not recreate the canvas, camera or particle fields.
  useEffect(() => {
    projectTimeRef.current();
  }, [selectedPath, stars]);

  const canFocusSelected = selectedPath !== null &&
    stars.some((star) => star.entry.path === selectedPath);

  return (
    <div className="files-constellation" ref={hostRef}
      role="region" tabIndex={0}
      aria-label={'Interactive 3D constellation of ' + stars.length + ' files and folders in ' + folderName}
      onPointerDown={(event) => {
        if (event.target instanceof HTMLCanvasElement) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.altKey || event.metaKey) return;
        const action = fileZoomActionFromKey(event.key, event.code);
        if (!action || (action === 'focus' && !canFocusSelected)) return;
        event.preventDefault();
        zoomCommandRef.current(action);
      }}>
      <div className="files-space-help" aria-hidden="true">
        <span>Wheel to zoom toward cursor</span><span>Pinch to zoom</span>
        <span>Drag to orbit</span><span>Double-click a star to open</span>
      </div>
      <div className="files-zoom-controls" role="group" aria-label="3D constellation zoom controls">
        <button type="button" aria-label="Zoom in" title="Zoom in (+)"
          onClick={() => zoomCommandRef.current('in')}>+</button>
        <button type="button" aria-label="Zoom out" title="Zoom out (-)"
          onClick={() => zoomCommandRef.current('out')}>−</button>
        <button type="button" disabled={!canFocusSelected}
          aria-label="Focus camera on selected star" title="Focus on selected star (F)"
          onClick={() => zoomCommandRef.current('focus')}>Focus star</button>
        <button type="button" aria-label="Reset constellation camera"
          title="Return to full constellation (0)"
          onClick={() => zoomCommandRef.current('reset')}>Reset</button>
      </div>
      <div className="files-space-legend" aria-hidden="true">
        <span className="files-space-legend-head">LIVE CONSTELLATION</span>
        <span>● Folder stars are larger</span>
        <span>✦ Connections reflect folder membership</span>
        <span>Cosmetic clusters never move files</span>
      </div>
      {hovered ? (
        <div className="files-star-tooltip" role="status">
          <strong>{hovered.name}</strong>
          <span>{hovered.isDirectory ? 'Folder' : hovered.kind} · Click to inspect</span>
        </div>
      ) : null}
      {degraded ? (
        <div className="files-fx-adaptive" role="status">
          Graphics load reduced automatically. Files remain accessible.
        </div>
      ) : null}
      {reducedMotion ? (
        <div className="files-fx-reduced" role="status">
          Reduced motion: particle animation paused
        </div>
      ) : null}
      {entries.length > stars.length ? (
        <div className="files-space-limit" role="status">
          Showing {stars.length} of {entries.length} stars. Switch to List to access every item.
        </div>
      ) : null}
    </div>
  );
}
