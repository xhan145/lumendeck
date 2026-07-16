import * as THREE from 'three';

/**
 * Signature shaders for the Open Constellation. Three materials:
 *
 *  - OpenSignal planet: layered FBM surface with slow geological drift + fine
 *    detail, deep dark regions crossed by luminous signal seams, animated
 *    contour bands, longitudinal "open" seams whose energy travels OUTWARD
 *    (the visual argument for FREE/OPEN — nothing collapses inward), Fresnel
 *    rim, a soft luminous core, and subtle stable vertex displacement.
 *  - Atmosphere shell: back-side Fresnel glow, additive, transparent,
 *    depth-write off, intensity-configurable.
 *  - Broadcast rings: expanding equatorial signal waves radiating outward.
 *
 * All GLSL3 (fwidth/derivatives are core on WebGL2; three 0.185 removed the
 * legacy extensions flag — the same decision as graph3d/fabric.ts). Animation
 * flows ONLY through uniforms updated from the render loop — never React state,
 * never new material/uniform objects per frame. `uMotion` scales every
 * time-driven term so prefers-reduced-motion can freeze the surface without
 * losing the data story (colors, seams, silhouette all remain).
 */

// ---------------------------------------------------------------------------
// Shared GLSL: hash / value noise / FBM (self-contained, no textures).
// ---------------------------------------------------------------------------
const NOISE_GLSL = /* glsl */ `
  float ldHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.13));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float ldNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(ldHash(i + vec3(0,0,0)), ldHash(i + vec3(1,0,0)), f.x),
          mix(ldHash(i + vec3(0,1,0)), ldHash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(ldHash(i + vec3(0,0,1)), ldHash(i + vec3(1,0,1)), f.x),
          mix(ldHash(i + vec3(0,1,1)), ldHash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  float ldFbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * ldNoise(p);
      p = p * 2.02 + vec3(31.7, 11.3, 7.9);
      a *= 0.5;
    }
    return v;
  }
`;

// ---------------------------------------------------------------------------
// OpenSignal planet
// ---------------------------------------------------------------------------
const OPEN_SIGNAL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;     // 1 normal, 0 reduced-motion (freezes drift)
  uniform float uDisplace;   // vertex displacement amplitude (world units)
  uniform float uSeed;
  out vec3 vNormalW;
  out vec3 vViewPos;
  out vec3 vObjPos;
  ${NOISE_GLSL}
  void main() {
    vObjPos = position;
    // Subtle, stable displacement: low-frequency FBM drifting slowly. Amplitude
    // stays a small fraction of the radius so silhouettes never tear.
    float bump = ldFbm(normalize(position) * 2.4 + vec3(uSeed) + uTime * 0.03 * uMotion);
    vec3 displaced = position + normal * (bump - 0.5) * uDisplace;
    vNormalW = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const OPEN_SIGNAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;
  uniform float uEnergy;     // 0.3 dormant satellite .. 1 selected planet
  uniform float uSeed;
  uniform vec3 uColorA;      // node primary
  uniform vec3 uColorB;      // node secondary
  in vec3 vNormalW;
  in vec3 vViewPos;
  in vec3 vObjPos;
  out vec4 fragColor;
  ${NOISE_GLSL}
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 viewDir = normalize(-vViewPos);
    vec3 sp = normalize(vObjPos);            // unit sphere coords (stable)
    float t = uTime * uMotion;

    // --- Surface: slow large-scale movement + fine high-frequency detail ----
    vec3 warp = vec3(ldFbm(sp * 1.7 + uSeed + t * 0.015)) * 1.4;
    float continents = ldFbm(sp * 2.3 + warp + uSeed);
    float detail = ldFbm(sp * 9.0 + uSeed * 3.0 + t * 0.05);
    float terrain = continents * 0.75 + detail * 0.25;

    // Deep dark regions vs luminous plateaus.
    vec3 deep = mix(uColorB * 0.10, uColorB * 0.28, detail);
    vec3 lit = mix(uColorA * 0.55, uColorB * 0.9, continents);
    vec3 base = mix(deep, lit, smoothstep(0.38, 0.62, terrain));

    // --- Animated contour bands (etched data-lines over the terrain) --------
    float contourPhase = terrain * 14.0 - t * 0.35;
    float contourAA = fwidth(contourPhase);
    float contour = 1.0 - smoothstep(0.0, contourAA * 1.8, abs(fract(contourPhase) - 0.5));
    base += uColorA * contour * 0.10 * (0.4 + 0.6 * uEnergy);

    // --- Open signal: longitudinal seams whose energy travels OUTWARD -------
    // Longitude bands "open" and carry bright pulses from the core toward the
    // poles/edges: phase runs with +|latitude| - t, so motion reads outward.
    float lon = atan(sp.z, sp.x);
    float lat = asin(clamp(sp.y, -1.0, 1.0));
    float seamMask = smoothstep(0.88, 0.995, sin(lon * 3.0 + uSeed * 6.2831) * 0.5 + 0.5);
    float outward = fract(abs(lat) * 1.6 - t * 0.22);
    float pulse = smoothstep(0.72, 0.98, outward) * (1.0 - smoothstep(0.98, 1.0, outward));
    float seam = seamMask * (0.35 + 0.65 * pulse);
    vec3 seamColor = mix(uColorA, vec3(1.0), 0.35);
    base += seamColor * seam * (0.35 + 0.85 * uEnergy);

    // --- Luminous signal paths through the dark regions ---------------------
    float veins = ldFbm(sp * 5.0 + uSeed * 7.0 - t * 0.04);
    float vein = smoothstep(0.492, 0.5, veins) * (1.0 - smoothstep(0.5, 0.508, veins));
    base += uColorA * vein * (1.0 - smoothstep(0.38, 0.62, terrain)) * 2.2 * (0.5 + 0.5 * uEnergy);

    // --- Fresnel rim + soft luminous core ------------------------------------
    float ndv = max(dot(n, viewDir), 0.0);
    float rim = pow(1.0 - ndv, 3.0);
    base += mix(uColorA, uColorB, 0.4) * rim * (0.35 + 0.55 * uEnergy);
    float core = pow(ndv, 2.4);
    base += uColorA * core * 0.16 * uEnergy;

    // Cheap half-lambert so the sphere reads as a body, not a flat disc.
    float diff = 0.5 + 0.5 * max(dot(n, normalize(vec3(0.4, 0.75, 0.5))), 0.0);
    base *= 0.55 + 0.45 * diff;

    fragColor = vec4(base, 1.0);
  }
`;

export interface OpenSignalUniforms {
  uTime: { value: number };
  uMotion: { value: number };
  uEnergy: { value: number };
  uDisplace: { value: number };
  uSeed: { value: number };
  uColorA: { value: THREE.Color };
  uColorB: { value: THREE.Color };
}

/**
 * The planet/satellite surface material. `radius` scales displacement so small
 * moons stay stable; `energy` is 1 for the selected center, lower for others.
 */
export function createOpenSignalMaterial(
  colors: [string, string],
  seed: number,
  opts?: { energy?: number; radius?: number; motion?: number },
): THREE.ShaderMaterial {
  const radius = opts?.radius ?? 1;
  return new THREE.ShaderMaterial({
    vertexShader: OPEN_SIGNAL_VERTEX,
    fragmentShader: OPEN_SIGNAL_FRAGMENT,
    glslVersion: THREE.GLSL3,
    uniforms: {
      uTime: { value: 0 },
      uMotion: { value: opts?.motion ?? 1 },
      uEnergy: { value: opts?.energy ?? 1 },
      uDisplace: { value: radius * 0.035 },
      uSeed: { value: seed % 1000 },
      uColorA: { value: new THREE.Color(colors[0]) },
      uColorB: { value: new THREE.Color(colors[1]) },
    } satisfies OpenSignalUniforms as unknown as Record<string, THREE.IUniform>,
  });
}

// ---------------------------------------------------------------------------
// Atmosphere shell
// ---------------------------------------------------------------------------
const ATMOSPHERE_VERTEX = /* glsl */ `
  out vec3 vNormalW;
  out vec3 vViewPos;
  void main() {
    vNormalW = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  in vec3 vNormalW;
  in vec3 vViewPos;
  out vec4 fragColor;
  void main() {
    // Back-side shell: the rim (grazing angles) glows, the center stays clear.
    float ndv = abs(dot(normalize(vNormalW), normalize(-vViewPos)));
    float fresnel = pow(1.0 - ndv, 2.6);
    fragColor = vec4(uColor, fresnel * uIntensity);
  }
`;

/** Fresnel atmosphere: render on a slightly larger sphere than its body. */
export function createAtmosphereMaterial(color: string, intensity = 0.55): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
    },
  });
}

// ---------------------------------------------------------------------------
// Broadcast rings — expanding signal waves (openness made visible)
// ---------------------------------------------------------------------------
const BROADCAST_VERTEX = /* glsl */ `
  out vec2 vLocal;
  void main() {
    vLocal = position.xy;              // flat quad in local XY, rotated flat by the mesh
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BROADCAST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;
  uniform vec3 uColor;
  uniform float uInner;      // planet radius (rings start outside the body)
  uniform float uOuter;      // fade-out radius
  in vec2 vLocal;
  out vec4 fragColor;
  void main() {
    float r = length(vLocal);
    if (r < uInner || r > uOuter) discard;
    float span = uOuter - uInner;
    float norm = (r - uInner) / span;
    // Three concurrent waves expanding outward forever (never collapsing in).
    float wavePhase = fract(norm * 3.0 - uTime * 0.35 * uMotion);
    float ring = smoothstep(0.86, 0.985, wavePhase) * (1.0 - smoothstep(0.985, 1.0, wavePhase));
    // Rings weaken with distance but never hit a wall — the fade is open-ended.
    float falloff = (1.0 - norm) * (1.0 - norm);
    float alpha = ring * falloff * 0.6 + falloff * 0.03;
    if (alpha <= 0.003) discard;
    fragColor = vec4(uColor, alpha);
  }
`;

/** Equatorial expanding broadcast rings around the selected planet. */
export function createBroadcastMaterial(color: string, inner: number, outer: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: BROADCAST_VERTEX,
    fragmentShader: BROADCAST_FRAGMENT,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uMotion: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uInner: { value: inner },
      uOuter: { value: outer },
    },
  });
}
