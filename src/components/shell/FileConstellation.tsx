import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FileEntry } from '../../bridge/files';
import { FILE_GROUPS, makeFileStars } from '../../core/shell/fileMap';

/**
 * A true three-dimensional projection of one real directory. Stars and links
 * are only a view: dragging/orbiting cannot move, rename or write to disk.
 * File actions are dispatched to the same explicit controls as list view.
 */
export function FileConstellation({
  entries, selectedPath, folderName, onSelect, onOpen, onUnavailable,
}: {
  entries: FileEntry[];
  selectedPath: string | null;
  folderName: string;
  onSelect: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onUnavailable: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const meshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  const onSelectRef = useRef(onSelect);
  const onOpenRef = useRef(onOpen);
  const unavailableRef = useRef(onUnavailable);
  onSelectRef.current = onSelect;
  onOpenRef.current = onOpen;
  unavailableRef.current = onUnavailable;
  const stars = useMemo(() => makeFileStars(entries), [entries]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      unavailableRef.current();
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0e1b');
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 180);
    camera.position.set(0, 0.8, 28);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 7;
    controls.maxDistance = 65;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    // Deterministic distant reference stars, not simulated filesystem entries.
    let rng = 12345678;
    const random = () => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng / 4294967296;
    };
    const positions = new Float32Array(600 * 3);
    for (let i = 0; i < 600; i++) {
      positions[i * 3] = (random() - 0.5) * 95;
      positions[i * 3 + 1] = (random() - 0.5) * 60;
      positions[i * 3 + 2] = -20 - random() * 35;
    }
    const specks = new THREE.BufferGeometry();
    specks.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(specks, new THREE.PointsMaterial({
      color: '#9a91bb', transparent: true, opacity: 0.5, size: 0.08, sizeAttenuation: true,
    })));

    const root = new THREE.Mesh(
      new THREE.SphereGeometry(0.47, 22, 18),
      new THREE.MeshBasicMaterial({ color: '#d4c3ff' }),
    );
    scene.add(root);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 20, 16),
      new THREE.MeshBasicMaterial({
        color: '#9981d5', transparent: true, opacity: 0.075, depthWrite: false,
      }),
    );
    scene.add(halo);

    const groupCenters = new Map<string, THREE.Vector3>();
    const pickables: THREE.Mesh[] = [];
    const entryByPath = new Map(stars.map((star) => [star.entry.path, star.entry]));
    const sphere = new THREE.SphereGeometry(1, 14, 10);
    for (const star of stars) {
      const point = new THREE.Vector3(star.x, star.y, star.z);
      const color = new THREE.Color(star.color);
      const selected = star.entry.path === selectedRef.current;
      const mesh = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({
        color: selected ? '#ffffff' : color,
      }));
      mesh.scale.setScalar(selected ? 0.31 : star.entry.isDirectory ? 0.25 : 0.15);
      mesh.position.copy(point);
      mesh.userData.path = star.entry.path;
      mesh.userData.baseColor = star.color;
      scene.add(mesh);
      pickables.push(mesh);

      const link = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), point]),
        new THREE.LineBasicMaterial({
          color, transparent: true, opacity: selected ? 0.42 : 0.11,
          depthWrite: false,
        }),
      );
      scene.add(link);

      if (!groupCenters.has(star.group)) {
        groupCenters.set(star.group, point.clone());
      }
    }

    meshesRef.current = new Map(pickables.map((mesh) => [mesh.userData.path as string, mesh]));

    // A few section labels keep the spatial map readable at any orbit angle.
    for (const group of FILE_GROUPS) {
      const center = groupCenters.get(group.kind);
      if (!center) continue;
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 512;
      labelCanvas.height = 96;
      const context = labelCanvas.getContext('2d');
      if (!context) continue;
      context.fillStyle = '#e5dff4';
      context.font = '600 39px system-ui';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(group.label.toUpperCase(), 256, 48, 490);
      const texture = new THREE.CanvasTexture(labelCanvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, opacity: 0.88, depthTest: false,
      }));
      sprite.position.copy(center).add(new THREE.Vector3(0, 1.4, 0));
      sprite.scale.set(4.3, 0.8, 1);
      scene.add(sprite);
    }

    // The center star represents the current directory, not an invented file.
    const rootCanvas = document.createElement('canvas');
    rootCanvas.width = 512;
    rootCanvas.height = 96;
    const rootContext = rootCanvas.getContext('2d');
    if (rootContext) {
      rootContext.fillStyle = '#e2d5ff';
      rootContext.font = '600 35px system-ui';
      rootContext.textAlign = 'center';
      rootContext.fillText(folderName.slice(0, 34), 256, 60, 500);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(rootCanvas),
        transparent: true, depthTest: false,
      }));
      sprite.position.set(0, -1.15, 0);
      sprite.scale.set(4.7, 0.88, 1);
      scene.add(sprite);
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (event: MouseEvent): FileEntry | undefined => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      const path = hit?.object.userData.path as string | undefined;
      return path ? entryByPath.get(path) : undefined;
    };
    let down: { x: number; y: number } | null = null;
    const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
    const click = (event: MouseEvent) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
      const found = pick(event);
      if (found) onSelectRef.current(found);
    };
    const doubleClick = (event: MouseEvent) => {
      const found = pick(event);
      if (found) onOpenRef.current(found);
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('click', click);
    renderer.domElement.addEventListener('dblclick', doubleClick);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    let request = 0;
    const frame = () => {
      controls.update();
      renderer.render(scene, camera);
      request = requestAnimationFrame(frame);
    };
    request = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('click', click);
      renderer.domElement.removeEventListener('dblclick', doubleClick);
      controls.dispose();
      scene.traverse((item) => {
        if (item instanceof THREE.Mesh || item instanceof THREE.Line || item instanceof THREE.Points) {
          if (item.geometry !== sphere) item.geometry.dispose();
        }
        if ('material' in item) {
          const material = item.material as THREE.Material | THREE.Material[];
          for (const m of Array.isArray(material) ? material : [material]) {
            if (m instanceof THREE.SpriteMaterial && m.map) m.map.dispose();
            m.dispose();
          }
        }
      });
      sphere.dispose();
      meshesRef.current.clear();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [stars, folderName]);

  // Selection should not destroy and recreate WebGL or reset the camera orbit.
  useEffect(() => {
    for (const [path, mesh] of meshesRef.current) {
      const chosen = path === selectedPath;
      (mesh.material as THREE.MeshBasicMaterial).color.set(
        chosen ? '#ffffff' : (mesh.userData.baseColor as string),
      );
      const file = stars.find((star) => star.entry.path === path);
      mesh.scale.setScalar(chosen ? 0.31 : file?.entry.isDirectory ? 0.25 : 0.15);
    }
  }, [selectedPath, stars]);

  return (
    <div className="files-constellation" ref={hostRef} role="img"
      aria-label={`3D constellation of ${stars.length} files and folders in ${folderName}`}>
      <div className="files-space-help" aria-hidden="true">
        <span>Orbit: drag</span><span>Zoom: scroll</span><span>Select: click</span><span>Open: double-click</span>
      </div>
      {entries.length > stars.length ? (
        <div className="files-space-limit" role="status">
          Showing {stars.length} of {entries.length} stars. Switch to List for every item.
        </div>
      ) : null}
    </div>
  );
}
