import * as THREE from 'three';
import type { ConstellationNode } from './types';
import { hashString, orbitPointAt, type OrbitParams } from './orbits';
import {
  createAtmosphereMaterial,
  createBroadcastMaterial,
  createOpenSignalMaterial,
} from './openSignalMaterial';

/**
 * three-only builders for constellation bodies. Construction needs no GL
 * context (node-env testable, like graph3d/fabric.ts); every handle owns its
 * disposal. Geometry detail is passed in by the scene so quality tiers control
 * cost; geometries are per-body because scales differ, but segment counts stay
 * proportional to visual importance (planet ≫ satellite ≫ moon).
 */

export interface BodyHandle {
  /** Group containing the surface mesh (+ optional atmosphere shell). */
  readonly group: THREE.Group;
  /** The pickable surface mesh (userData.nodeId is set for raycasting). */
  readonly mesh: THREE.Mesh;
  setTime(tSec: number): void;
  setEnergy(v: number): void;
  setMotion(v: number): void;
  dispose(): void;
}

export interface BodyOptions {
  radius: number;
  energy: number;
  motion: number;
  widthSegments: number;
  heightSegments: number;
  /** Add the Fresnel atmosphere shell (planet + hero satellites only). */
  atmosphere?: boolean;
  atmosphereIntensity?: number;
}

/** A shaded body (planet, satellite, or moon) for one constellation node. */
export function buildBody(node: ConstellationNode, opts: BodyOptions): BodyHandle {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(opts.radius, opts.widthSegments, opts.heightSegments);
  const material = createOpenSignalMaterial(node.colors, hashString(node.id) % 997, {
    energy: opts.energy,
    radius: opts.radius,
    motion: opts.motion,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.nodeId = node.id;
  group.add(mesh);

  let atmosphereGeometry: THREE.SphereGeometry | null = null;
  let atmosphereMaterial: THREE.ShaderMaterial | null = null;
  if (opts.atmosphere) {
    atmosphereGeometry = new THREE.SphereGeometry(
      opts.radius * 1.16,
      Math.max(12, Math.floor(opts.widthSegments / 2)),
      Math.max(8, Math.floor(opts.heightSegments / 2)),
    );
    atmosphereMaterial = createAtmosphereMaterial(node.colors[0], opts.atmosphereIntensity ?? 0.55);
    const shell = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    shell.renderOrder = 2; // after opaque bodies so the additive rim layers cleanly
    group.add(shell);
  }

  return {
    group,
    mesh,
    setTime(tSec) {
      material.uniforms.uTime.value = tSec;
    },
    setEnergy(v) {
      material.uniforms.uEnergy.value = v;
      if (atmosphereMaterial) atmosphereMaterial.uniforms.uIntensity.value = 0.3 + v * 0.5;
    },
    setMotion(v) {
      material.uniforms.uMotion.value = v;
    },
    dispose() {
      group.parent?.remove(group);
      geometry.dispose();
      material.dispose();
      atmosphereGeometry?.dispose();
      atmosphereMaterial?.dispose();
    },
  };
}

export interface BroadcastHandle {
  readonly mesh: THREE.Mesh;
  setTime(tSec: number): void;
  setMotion(v: number): void;
  dispose(): void;
}

/** Expanding broadcast rings in the system's equatorial plane. */
export function buildBroadcast(color: string, inner: number, outer: number): BroadcastHandle {
  const geometry = new THREE.PlaneGeometry(outer * 2, outer * 2, 1, 1);
  const material = createBroadcastMaterial(color, inner, outer);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2; // lay flat in XZ
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return {
    mesh,
    setTime(tSec) {
      material.uniforms.uTime.value = tSec;
    },
    setMotion(v) {
      material.uniforms.uMotion.value = v;
    },
    dispose() {
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

export interface OrbitLineHandle {
  readonly line: THREE.LineLoop;
  dispose(): void;
}

/** Faint orbital path so hierarchy reads without heavy connecting edges. */
export function buildOrbitLine(params: OrbitParams, color: string, segments = 96): OrbitLineHandle {
  const positions = new Float32Array(segments * 3);
  const v = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < segments; i++) {
    orbitPointAt(params, (i / segments) * Math.PI * 2, v);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.LineLoop(geometry, material);
  return {
    line,
    dispose() {
      line.parent?.remove(line);
      geometry.dispose();
      material.dispose();
    },
  };
}
