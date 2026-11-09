import * as THREE from 'three';
import type { FileStar } from '../../core/shell/fileMap';
import {
  CONTEXT_MAX_LINKS, type FileContextLens, type FileContextMode,
} from '../../core/shell/fileContext';

export interface ContextConnections {
  setLens(lens: FileContextLens | null, mode: FileContextMode): void;
  move(projectedXYZ: Float32Array): void;
  dispose(): void;
}

/**
 * At most 18 edges in one reusable GPU buffer. This is a fourth/fifth
 * coordinate overlay, not a second file graph or a hidden relationship scan.
 */
export function createContextConnections(
  scene: THREE.Scene,
  stars: readonly FileStar[],
): ContextConnections {
  const pathToIndex = new Map(stars.map((star, i) => [star.entry.path, i]));
  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(CONTEXT_MAX_LINKS * 6), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  const colors = new THREE.BufferAttribute(new Float32Array(CONTEXT_MAX_LINKS * 6), 3);
  geometry.setAttribute('color', colors);
  geometry.setDrawRange(0, 0);

  const material = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.75,
    depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.visible = false;
  lines.frustumCulled = false;
  lines.renderOrder = 4;
  scene.add(lines);

  let pairs: Array<[number, number]> = [];
  const dark = new THREE.Color('#7767a0');
  const light = new THREE.Color('#f3ddff');
  const tint = new THREE.Color();

  return {
    setLens(lens, mode) {
      pairs = [];
      if (mode !== 'off' && lens) {
        const rootIndex = pathToIndex.get(lens.anchor.path);
        if (rootIndex !== undefined) {
          for (const relation of lens.relations) {
            const index = pathToIndex.get(relation.entry.path);
            if (index === undefined || index === rootIndex) continue;
            const edgeIndex = pairs.length;
            if (edgeIndex >= CONTEXT_MAX_LINKS) break;
            pairs.push([rootIndex, index]);
            const t = Math.max(0, Math.min(1, relation.score / 100));
            tint.copy(dark).lerp(light, t);
            colors.setXYZ(edgeIndex * 2, tint.r, tint.g, tint.b);
            colors.setXYZ(edgeIndex * 2 + 1, tint.r, tint.g, tint.b);
          }
        }
      }
      colors.needsUpdate = true;
      lines.visible = pairs.length > 0;
      geometry.setDrawRange(0, pairs.length * 2);
      material.opacity = mode === 'focus' ? 0.95 : 0.74;
    },
    move(xyz) {
      if (!pairs.length || xyz.length !== stars.length * 3) return;
      for (const [index, pair] of pairs.entries()) {
        const start = pair[0] * 3;
        const end = pair[1] * 3;
        attr.setXYZ(index * 2, xyz[start], xyz[start + 1], xyz[start + 2]);
        attr.setXYZ(index * 2 + 1, xyz[end], xyz[end + 1], xyz[end + 2]);
      }
      attr.needsUpdate = true;
    },
    dispose() {
      scene.remove(lines);
      geometry.dispose();
      material.dispose();
    },
  };
}
