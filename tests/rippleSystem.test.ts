import { describe, it, expect } from 'vitest';
import { createFlashLimiter } from '../src/components/graph/graph3d/flashLimiter';
import { settleShouldRun } from '../src/components/graph/graph3d/settle';
import {
  rippleDisplacement,
  RIPPLE_AMP,
  RIPPLE_LIFETIME,
  MAX_RIPPLES,
  createFabric,
} from '../src/components/graph/graph3d/fabric';

describe('createFlashLimiter (WCAG 2.3.1 sliding window)', () => {
  it('allows up to maxOnsets within the window, rejects the rest', () => {
    const fl = createFlashLimiter(3, 1000);
    expect(fl.tryAdd(0)).toBe(true);
    expect(fl.tryAdd(100)).toBe(true);
    expect(fl.tryAdd(200)).toBe(true);
    expect(fl.tryAdd(300)).toBe(false); // 4th within the second — blocked
    expect(fl.activeCount(300)).toBe(3);
  });

  it('is a SLIDING window: a 4th onset ≥300ms apart is still blocked inside 1s', () => {
    const fl = createFlashLimiter(3, 1000);
    fl.tryAdd(0);
    fl.tryAdd(300);
    fl.tryAdd(600);
    expect(fl.tryAdd(900)).toBe(false); // 0,300,600 still in the [-100,900] window
  });

  it('admits a new onset once older ones age out of the window', () => {
    const fl = createFlashLimiter(3, 1000);
    fl.tryAdd(0);
    fl.tryAdd(300);
    fl.tryAdd(600);
    expect(fl.tryAdd(1001)).toBe(true); // the t=0 onset has left the 1000ms window
    expect(fl.activeCount(1001)).toBe(3); // 300,600,1001
  });
});

describe('settleShouldRun (double-render mutual exclusion)', () => {
  it('runs only when decay is pending AND no other driver owns the frame', () => {
    expect(settleShouldRun({ decayActive: true, playing: false, audioRunning: false })).toBe(true);
  });

  it('never runs while playback owns the frame, even with a live decay', () => {
    expect(settleShouldRun({ decayActive: true, playing: true, audioRunning: false })).toBe(false);
  });

  it('never runs while audio owns the frame, even with a live decay', () => {
    expect(settleShouldRun({ decayActive: true, playing: false, audioRunning: true })).toBe(false);
  });

  it('does not run when there is nothing to animate', () => {
    expect(settleShouldRun({ decayActive: false, playing: false, audioRunning: false })).toBe(false);
  });
});

describe('rippleDisplacement (CPU mirror of the vertex ripple term)', () => {
  const rp = (t0: number) => [{ x: 0, z: 0, t0, amp: RIPPLE_AMP }];

  it('is zero with no ripples', () => {
    expect(rippleDisplacement(0, 0, [], 0)).toBe(0);
  });

  it('peaks at the event center at age 0', () => {
    expect(rippleDisplacement(0, 0, rp(0), 0)).toBeCloseTo(RIPPLE_AMP, 3);
  });

  it('the crest travels outward: a far point lifts more once the ring reaches it', () => {
    const early = rippleDisplacement(700, 0, rp(0), 1); // age ~0, crest at ~0
    const onCrest = rippleDisplacement(700, 0, rp(0), 1000); // age 1s, crest at ~720
    expect(onCrest).toBeGreaterThan(early);
  });

  it('crest amplitude decays with age', () => {
    const young = rippleDisplacement(360, 0, rp(0), 500); // age 0.5s, crest ~360
    const old = rippleDisplacement(720, 0, rp(0), 1000); // age 1.0s, crest ~720
    expect(young).toBeGreaterThan(old);
  });

  it('contributes nothing once past its lifetime', () => {
    expect(rippleDisplacement(0, 0, rp(0), (RIPPLE_LIFETIME + 0.1) * 1000)).toBe(0);
  });
});

describe('fabric ripple queue', () => {
  it('pushRipple → tickRipples packs (x, z, age, amp) and counts live ripples', () => {
    const f = createFabric('minimal', '#34D6F4', '#7C3AED');
    f.pushRipple(100, 200, 0);
    const alive = f.tickRipples(500); // age 0.5s
    const mat = (f.group.children[0] as import('three').Mesh).material as import('three').ShaderMaterial;
    expect(alive).toBe(true);
    expect(mat.uniforms.uRippleCount.value).toBe(1);
    const arr = mat.uniforms.uRipples.value as import('three').Vector4[];
    expect(arr[0].x).toBe(100);
    expect(arr[0].y).toBe(200);
    expect(arr[0].z).toBeCloseTo(0.5, 3); // age in seconds packed into vec4.z
    f.dispose();
  });

  it('culls dead ripples and reports not-alive', () => {
    const f = createFabric('minimal', '#34D6F4', '#7C3AED');
    f.pushRipple(0, 0, 0);
    const t = (RIPPLE_LIFETIME + 0.5) * 1000;
    const alive = f.tickRipples(t);
    const mat = (f.group.children[0] as import('three').Mesh).material as import('three').ShaderMaterial;
    expect(alive).toBe(false);
    expect(mat.uniforms.uRippleCount.value).toBe(0);
    expect(f.ripplesAlive(t)).toBe(false);
    f.dispose();
  });

  it('caps the queue at MAX_RIPPLES (drops the oldest)', () => {
    const f = createFabric('minimal', '#34D6F4', '#7C3AED');
    for (let i = 0; i < MAX_RIPPLES + 3; i++) f.pushRipple(i, 0, 0);
    f.tickRipples(0);
    const mat = (f.group.children[0] as import('three').Mesh).material as import('three').ShaderMaterial;
    expect(mat.uniforms.uRippleCount.value).toBe(MAX_RIPPLES);
    f.dispose();
  });
});
