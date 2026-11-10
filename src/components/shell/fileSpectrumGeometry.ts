import * as THREE from 'three';
import {
  SPECTRUM_GRADIENT_DARK, SPECTRUM_GRADIENT_LIGHT,
} from '../../core/shell/fileSpectrum';

export interface StarGradientSurface {
  setActive(active: boolean): void;
}

/**
 * Per-vertex gradient on one shared instanced star geometry.
 * Three.js MeshBasicMaterial's built-in vertexColors multiply each file's
 * individual instanceColor. No custom GLSL, extra draw call, or texture.
 */
export function makeStarGradientSurface(geometry: THREE.BufferGeometry): StarGradientSurface {
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const data = new Float32Array(positions.count * 3);
  const colors = new THREE.BufferAttribute(data, 3);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('color', colors);
  let current: boolean | null = null;

  const setActive = (active: boolean) => {
    if (current === active) return;
    current = active;
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      const p = Math.max(0, Math.min(1, (y + 0.85) / 1.7));
      const smooth = p * p * (3 - 2 * p);
      colors.setXYZ(i,
        active ? THREE.MathUtils.lerp(SPECTRUM_GRADIENT_DARK[0], SPECTRUM_GRADIENT_LIGHT[0], smooth) : 1,
        active ? THREE.MathUtils.lerp(SPECTRUM_GRADIENT_DARK[1], SPECTRUM_GRADIENT_LIGHT[1], smooth) : 1,
        active ? THREE.MathUtils.lerp(SPECTRUM_GRADIENT_DARK[2], SPECTRUM_GRADIENT_LIGHT[2], smooth) : 1,
      );
    }
    colors.needsUpdate = true;
  };

  setActive(true);
  return { setActive };
}
