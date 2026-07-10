import * as THREE from 'three';

/**
 * Scene environment for the higher effect tiers: a distant static starfield
 * (the parallax anchor that makes camera motion read as travel through SPACE
 * rather than panning a flat backdrop) and, for the cinematic tier, an opaque
 * deep-space dome.
 *
 * The dome exists for a hard technical reason, not decoration: the bloom
 * composer (UnrealBloomPass) does not preserve the transparent canvas alpha,
 * so the cinematic tier must render an opaque background. The dome's gradient
 * mirrors the .graph3d-wrap CSS backdrop so switching tiers doesn't jump.
 * Both layers are static (zero per-frame cost) and deterministic.
 */

export interface EnvironmentHandle {
  readonly object: THREE.Object3D;
  dispose(): void;
}

const STAR_VERTEX_SHADER = /* glsl */ `
  in float aSize;
  in float aTint;
  out float vTint;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize;
    vTint = aTint;
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  in float vTint;
  out vec4 fragColor;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d2 = dot(q, q);
    if (d2 > 0.25) discard;
    float core = exp(-d2 * 24.0);
    fragColor = vec4(mix(uColorA, uColorB, vTint), core * 0.85);
  }
`;

/**
 * A deterministic shell of distant stars between innerRadius and outerRadius,
 * biased toward the upper hemisphere (the fabric owns the lower half).
 */
export function createStarfield(
  count: number,
  innerRadius: number,
  outerRadius: number,
  colorA: string,
  colorB: string,
): EnvironmentHandle {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const tints = new Float32Array(count);

  let seed = 0x51f7a3c9 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    // Uniform direction, then bias y upward (fold most of the lower dome up).
    const zr = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - zr * zr));
    let y = zr;
    if (y < -0.15 && rand() < 0.7) y = -y;
    const radius = innerRadius + rand() * (outerRadius - innerRadius);
    positions[i * 3] = r * Math.cos(theta) * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = r * Math.sin(theta) * radius;
    sizes[i] = 1 + rand() * 2.4;
    tints[i] = rand();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
    },
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -9; // behind everything except the backdrop dome

  return {
    object: points,
    dispose() {
      points.parent?.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}

const DOME_VERTEX_SHADER = /* glsl */ `
  out vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  in vec3 vDir;
  out vec4 fragColor;
  void main() {
    float t = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    // OPAQUE — this is what makes the bloom composer safe over the DOM.
    fragColor = vec4(mix(uBottom, uTop, t), 1.0);
  }
`;

/** An opaque inward-facing gradient dome (deep space) for the cinematic tier. */
export function createBackdrop(radius: number, topColor: string, bottomColor: string): EnvironmentHandle {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const material = new THREE.ShaderMaterial({
    vertexShader: DOME_VERTEX_SHADER,
    fragmentShader: DOME_FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(topColor) },
      uBottom: { value: new THREE.Color(bottomColor) },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10; // first — everything draws over it

  return {
    object: mesh,
    dispose() {
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
