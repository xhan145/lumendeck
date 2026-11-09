import * as THREE from 'three';
import type { FileFxMode } from '../../state/appSettings';

export interface FileNebulaBackdrop {
  resize(): void;
  dispose(): void;
}

/**
 * Offline, deterministic analog-space backdrop. One canvas texture is created
 * per Files 3D scene, then held behind all interactive geometry.
 * No animations, network textures, extra rendering passes, or filesystem IO.
 */
export function createFileNebulaBackdrop(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: FileFxMode,
): FileNebulaBackdrop {
  if (quality === 'off') {
    return { resize() {}, dispose() {} };
  }

  const width = quality === 'cinematic' ? 1024 : 640;
  const height = quality === 'cinematic' ? 640 : 400;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    return { resize() {}, dispose() {} };
  }

  const ink = ctx.createLinearGradient(0, 0, width, height);
  ink.addColorStop(0, '#070913');
  ink.addColorStop(0.42, '#100d23');
  ink.addColorStop(1, '#080c19');
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, width, height);

  // Anisotropic, layered gradients mimic faint long-exposure gas clouds.
  // Avoid neon hues, animated noise, or a bright central spotlight.
  const clouds = [
    { x: 0.19, y: 0.37, r: 0.53, stretch: 0.40, angle: -0.31,
      inner: 'rgba(85, 50, 139, 0.38)', middle: 'rgba(54, 40, 98, 0.12)' },
    { x: 0.71, y: 0.36, r: 0.43, stretch: 0.51, angle: 0.32,
      inner: 'rgba(65, 80, 127, 0.30)', middle: 'rgba(60, 52, 113, 0.11)' },
    { x: 0.52, y: 0.85, r: 0.48, stretch: 0.24, angle: -0.16,
      inner: 'rgba(123, 72, 151, 0.21)', middle: 'rgba(76, 53, 111, 0.10)' },
    { x: 0.40, y: 0.10, r: 0.34, stretch: 0.33, angle: 0.46,
      inner: 'rgba(66, 44, 113, 0.17)', middle: 'rgba(56, 47, 102, 0.07)' },
  ] as const;

  for (const cloud of clouds) {
    ctx.save();
    ctx.translate(cloud.x * width, cloud.y * height);
    ctx.rotate(cloud.angle);
    ctx.scale(1, cloud.stretch);
    const radius = cloud.r * width;
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, cloud.inner);
    gradient.addColorStop(0.48, cloud.middle);
    gradient.addColorStop(1, 'rgba(7, 8, 19, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
  }

  // Seeded film grain is baked ONCE. No sparkle loops or texture updates.
  let seed = 0x4d454b41;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const grainCount = quality === 'cinematic' ? 5200 : 1500;
  for (let i = 0; i < grainCount; i++) {
    const x = Math.floor(random() * width);
    const y = Math.floor(random() * height);
    const silver = random() > 0.32;
    ctx.fillStyle = silver ? 'rgba(197, 179, 221, 0.035)' : 'rgba(0, 0, 0, 0.085)';
    ctx.fillRect(x, y, 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const plane = new THREE.Mesh(geometry, material);
  plane.position.set(0, 0, -160);
  plane.renderOrder = -100;
  // Camera-space placement keeps the ink field behind the stars at any orbit.
  // Native 3D stars/links remain in world space for correct raycasting.
  camera.add(plane);
  scene.add(camera);

  return {
    resize() {
      const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 160;
      plane.scale.set(viewHeight * camera.aspect * 1.035, viewHeight * 1.035, 1);
    },
    dispose() {
      camera.remove(plane);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
