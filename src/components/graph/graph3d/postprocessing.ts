import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';

/**
 * Cinematic post pipeline (cinematic tier only): RenderPass → UnrealBloomPass →
 * CopyPass. BLOOM-ONLY by explicit decision:
 *
 * ACES filmic tone mapping (OutputPass) was evaluated and REJECTED. Every
 * material in this scene is a custom ShaderMaterial authored in display-ready
 * sRGB values; OutputPass assumes a linear working buffer and applies a
 * linear→sRGB conversion + filmic curve, which visibly brightened and
 * desaturated the whole palette — orb data colors washed to pastel, the exact
 * failure the "bloom must not eat data colors" rule forbids. Adopting a filmic
 * pipeline correctly would mean re-authoring every shader in linear space; the
 * copy pass instead preserves the authored look bit-for-bit and adds only the
 * high-threshold glow.
 *
 * Rules pinned here:
 *  - Bloom threshold is HIGH (0.85): only genuinely bright pixels — energized
 *    dust, pulse cores, glowing orbs, specular glints — bloom. Wires, cards,
 *    and socket colors stay crisp. The CSS3D DOM layer is composited by the
 *    browser ABOVE the canvas and is never touched by this pipeline.
 *  - The caller must ensure an OPAQUE background (environment.createBackdrop):
 *    UnrealBloomPass does not preserve canvas alpha.
 */

export interface PostPipelineOptions {
  strength?: number;
  radius?: number;
  threshold?: number;
}

export interface PostPipeline {
  /** Render one frame through the composer (replaces renderer.render). */
  render(): void;
  /** Track viewport resizes (call from the host's ResizeObserver). */
  setSize(width: number, height: number): void;
  /** Dispose composer targets + passes (idempotent). */
  dispose(): void;
}

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts?: PostPipelineOptions,
): PostPipeline {
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(Math.max(1, size.x), Math.max(1, size.y));

  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(Math.max(1, size.x), Math.max(1, size.y)),
    opts?.strength ?? 0.55,
    opts?.radius ?? 0.45,
    opts?.threshold ?? 0.85,
  );
  composer.addPass(bloom);
  // Plain copy to the canvas: NO tone mapping, NO color-space conversion — the
  // authored palette reaches the screen exactly as the other tiers render it.
  const copyPass = new ShaderPass(CopyShader);
  composer.addPass(copyPass);

  let disposed = false;
  return {
    render() {
      if (!disposed) composer.render();
    },
    setSize(width, height) {
      if (disposed || width < 1 || height < 1) return;
      composer.setSize(width, height);
      bloom.setSize(width, height);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // EffectComposer.dispose() releases only ITS two ping-pong targets — the
      // bloom pass owns a whole mip chain of render targets that must be
      // disposed explicitly or every tier change leaks GPU memory.
      bloom.dispose();
      copyPass.material.dispose();
      composer.dispose();
    },
  };
}
