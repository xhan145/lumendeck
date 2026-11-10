import * as THREE from 'three';
import {
  createSpacetimeLinePositions, SPACETIME_QUALITY,
  type FileSpacetimeMode,
} from '../../core/shell/fileSpacetime';
import type { FileFxMode } from '../../state/appSettings';

/**
 * Single-draw spacetime contours. Only five uniforms update while the
 * timeline runs. The static line-vertex buffer is warped in the GPU shader,
 * never regenerated on the CPU per frame.
 *
 * This is a restrained visual interpretation of file modification time,
 * not physical spacetime measurements or reconstructed file history.
 */
const FIELD_VERTEX = /* glsl */ `
  uniform float uProgress;
  uniform float uClock;
  uniform vec2 uFocus;
  uniform float uFocusStrength;
  varying float vFade;
  varying float vWell;

  void main() {
    vec3 p = position;
    float edge = max(abs(p.x) / 20.0, abs(p.y) / 13.0);

    // A selected file forms an abstract focus well behind the actual stars.
    vec2 relative = p.xy - uFocus;
    float radius = length(relative);
    float well = exp(-radius * radius / 48.0) * uFocusStrength;
    p.xy -= relative / (radius + 1.0) * well * 0.48;
    p.z += well * 0.92;

    // T is the actual 4D playhead, while uClock only animates in Flow mode.
    float phase = p.x * 0.29 + p.y * 0.21 + uProgress * 6.283185;
    p.z += 0.16 * sin(phase + uClock * 0.23);
    vFade = 1.0 - smoothstep(0.63, 1.0, edge);
    vWell = well;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FIELD_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying float vFade;
  varying float vWell;

  void main() {
    // Low-contrast slate/purple strokes; deliberately below the bloom gate.
    vec3 ink = mix(vec3(0.35, 0.34, 0.53), vec3(0.62, 0.52, 0.74),
      clamp(vWell * 0.63, 0.0, 1.0));
    gl_FragColor = vec4(ink, uOpacity * vFade);
  }
`;

export interface FileSpacetimeField {
  setMode(mode: FileSpacetimeMode): void;
  update(
    progress: number,
    focus: { x: number; y: number } | null,
    focusStrength: number,
    elapsedSeconds: number,
    animate: boolean,
  ): void;
  dispose(): void;
}

export function createFileSpacetimeField(
  scene: THREE.Scene,
  quality: FileFxMode,
  initialMode: FileSpacetimeMode,
): FileSpacetimeField {
  const budget = SPACETIME_QUALITY[quality];
  const positions = createSpacetimeLinePositions(budget);
  if (!positions.length) {
    return { setMode() {}, update() {}, dispose() {} };
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.ShaderMaterial({
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT,
    uniforms: {
      uProgress: { value: 0 },
      uClock: { value: 0 },
      uFocus: { value: new THREE.Vector2(0, 0) },
      uFocusStrength: { value: 0 },
      uOpacity: { value: budget.opacity },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
  const mesh = new THREE.LineSegments(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  scene.add(mesh);

  let mode = initialMode;
  let disposed = false;
  mesh.visible = mode !== 'off';
  return {
    setMode(next) {
      if (disposed) return;
      mode = next;
      mesh.visible = next !== 'off';
      if (next === 'contours') material.uniforms.uClock.value = 0;
    },
    update(progress, focus, strength, seconds, animate) {
      if (disposed || mode === 'off') return;
      material.uniforms.uProgress.value = Number.isFinite(progress)
        ? THREE.MathUtils.clamp(progress, 0, 1) : 0;
      material.uniforms.uFocusStrength.value = Number.isFinite(strength)
        ? THREE.MathUtils.clamp(strength, 0, 1) : 0;
      material.uniforms.uFocus.value.set(
        focus && Number.isFinite(focus.x) ? THREE.MathUtils.clamp(focus.x, -50, 50) : 0,
        focus && Number.isFinite(focus.y) ? THREE.MathUtils.clamp(focus.y, -50, 50) : 0,
      );
      // Uniform animation only. Freeze phase when time is paused or the app
      // requests reduced motion / GPU-adaptive degradation.
      if (mode === 'flow' && animate && Number.isFinite(seconds)) {
        material.uniforms.uClock.value = Math.max(0, seconds);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
