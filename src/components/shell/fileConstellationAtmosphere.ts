import * as THREE from 'three';
import type { FileStar } from '../../core/shell/fileMap';
import { makeParticleCloud, stableFileHash, type FileFxPreset } from '../../core/shell/fileFx';

/**
 * GPU-drawn nebula, dust and per-file halo layers. All particle positions are
 * cosmetic, stable and seeded. No particle can modify or create filesystem data.
 */
const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  attribute float aDrift;
  attribute float aFocus;
  varying vec3 vTint;
  varying float vEnergy;
  uniform float uTime;
  uniform float uMotion;
  uniform float uPixelRatio;

  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.18 + aPhase) * aDrift * uMotion;
    p.y += cos(uTime * 0.13 + aPhase * 1.7) * aDrift * 0.56 * uMotion;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    float twinkle = 0.86 + 0.14 * sin(uTime * 0.95 + aPhase * 3.0) * uMotion;
    vEnergy = twinkle * (1.0 + 0.8 * aFocus);
    vTint = color;
    float perspective = clamp(32.0 / max(1.0, -view.z), 0.42, 3.6);
    gl_PointSize = clamp(aSize * perspective * uPixelRatio * (1.0 + aFocus * 0.25), 1.0, 100.0);
    gl_Position = projectionMatrix * view;
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  varying float vEnergy;
  uniform float uOpacity;

  void main() {
    vec2 xy = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(xy, xy);
    if (r2 >= 1.0) discard;
    float halo = exp(-r2 * 5.4);
    float core = exp(-r2 * 62.0);
    float opacity = min(1.0, (halo * 0.28 + core * 0.98) * vEnergy * uOpacity);
    gl_FragColor = vec4(vTint, opacity * smoothstep(1.0, 0.5, r2));
  }
`;

interface ParticleLayer {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  focus?: THREE.BufferAttribute;
}

export interface FileAtmosphere {
  update(timeSeconds: number, animate: boolean): void;
  setPixelRatio(ratio: number): void;
  setFocus(selectedPath: string | null, hoverPath: string | null): void;
  dispose(): void;
}

function addLayer(
  scene: THREE.Scene,
  positions: Float32Array,
  colors: Float32Array,
  sizes: Float32Array,
  phases: Float32Array,
  drifts: Float32Array,
  opacity: number,
  renderOrder: number,
  focus?: Float32Array,
): ParticleLayer {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aDrift', new THREE.BufferAttribute(drifts, 1));
  const focusAttr = new THREE.BufferAttribute(focus ?? new Float32Array(sizes.length), 1);
  geometry.setAttribute('aFocus', focusAttr);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    vertexColors: true,
    uniforms: {
      uTime: { value: 0 },
      uMotion: { value: 1 },
      uPixelRatio: { value: 1 },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = renderOrder;
  points.frustumCulled = false;
  scene.add(points);
  return { points, focus: focus ? focusAttr : undefined };
}

function clusterMist(stars: FileStar[], perGroup: number) {
  const positions: number[] = [];
  const colors: number[] = [];
  const sizes: number[] = [];
  const phases: number[] = [];
  const drifts: number[] = [];
  if (!perGroup) return {
    positions: new Float32Array(), colors: new Float32Array(),
    sizes: new Float32Array(), phases: new Float32Array(), drifts: new Float32Array(),
  };

  const groups = new Map<string, FileStar[]>();
  for (const star of stars) {
    const group = groups.get(star.group) ?? [];
    group.push(star);
    groups.set(star.group, group);
  }

  for (const [kind, group] of groups) {
    let state = stableFileHash(kind + ':' + group.length);
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const center = group.reduce(
      (acc, star) => [acc[0] + star.x, acc[1] + star.y, acc[2] + star.z],
      [0, 0, 0],
    ).map((sum) => sum / group.length);
    const tint = new THREE.Color(group[0].color);
    const spread = 1.7 + Math.sqrt(group.length) * 0.25;

    for (let i = 0; i < perGroup; i++) {
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * spread;
      positions.push(
        center[0] + Math.cos(phi) * r,
        center[1] + Math.sin(phi) * r * 0.63,
        center[2] + (rand() - 0.5) * spread * 1.7,
      );
      const gain = 0.37 + rand() * 0.38;
      colors.push(tint.r * gain, tint.g * gain, tint.b * gain);
      sizes.push(10 + rand() * 31);
      phases.push(rand() * Math.PI * 2);
      drifts.push(0.07 + rand() * 0.25);
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    sizes: new Float32Array(sizes),
    phases: new Float32Array(phases),
    drifts: new Float32Array(drifts),
  };
}

export function createFileAtmosphere(
  scene: THREE.Scene,
  stars: FileStar[],
  preset: FileFxPreset,
): FileAtmosphere {
  const layers: ParticleLayer[] = [];

  const far = makeParticleCloud(preset.backgroundStars, 'distant');
  layers.push(addLayer(scene, far.positions, far.colors, far.sizes, far.phases, far.drifts, 0.78, -4));

  if (preset.ambientDust > 0) {
    const dust = makeParticleCloud(preset.ambientDust, 'dust', 0x2435a093);
    layers.push(addLayer(scene, dust.positions, dust.colors, dust.sizes, dust.phases, dust.drifts, 0.63, -2));
  }
  if (preset.clusterMist > 0 && stars.length) {
    const haze = clusterMist(stars, preset.clusterMist);
    layers.push(addLayer(scene, haze.positions, haze.colors, haze.sizes, haze.phases, haze.drifts, 0.35, -1));
  }

  // One GPU draw for all file halos plus the directory nucleus.
  const count = stars.length + 1;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const drifts = new Float32Array(count);
  const focus = new Float32Array(count);
  // Index 0 is the actual current directory's root anchor.
  colors.set([0.80, 0.66, 1.0], 0);
  sizes[0] = 96;
  phases[0] = 1.2;

  stars.forEach((star, index) => {
    const i = index + 1;
    positions.set([star.x, star.y, star.z], i * 3);
    const color = new THREE.Color(star.color);
    colors.set([color.r, color.g, color.b], i * 3);
    sizes[i] = star.entry.isDirectory ? 52 : 38;
    phases[i] = stableFileHash(star.entry.path) / 4294967296 * Math.PI * 2;
  });
  const glows = addLayer(scene, positions, colors, sizes, phases, drifts, 1.08, 3, focus);
  layers.push(glows);

  return {
    update(timeSeconds, animate) {
      for (const { points } of layers) {
        points.material.uniforms.uTime.value = timeSeconds;
        points.material.uniforms.uMotion.value = animate ? 1 : 0;
      }
    },
    setPixelRatio(pixelRatio) {
      for (const { points } of layers) {
        points.material.uniforms.uPixelRatio.value = pixelRatio;
      }
    },
    setFocus(selectedPath, hoverPath) {
      if (!glows.focus) return;
      const buffer = glows.focus;
      buffer.setX(0, 0.1);
      stars.forEach((star, index) => {
        const amount = star.entry.path === selectedPath ? 1
          : star.entry.path === hoverPath ? 0.55 : 0;
        buffer.setX(index + 1, amount);
      });
      buffer.needsUpdate = true;
    },
    dispose() {
      for (const { points } of layers) {
        scene.remove(points);
        points.geometry.dispose();
        points.material.dispose();
      }
    },
  };
}
