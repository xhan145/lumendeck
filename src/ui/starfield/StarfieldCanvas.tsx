import { useEffect, useRef } from 'react';
import { createStarfield, renderStarfield, stepStarfield } from './engine';

/**
 * The always-on ambient particle layer: one fixed 2D canvas behind the entire
 * shell (z-index 0, pointer-events none). Full density on every view — the
 * ONLY gate is prefers-reduced-motion, which renders a single static frame
 * and never starts the loop. Pauses while the document is hidden; dpr ≤ 2.
 *
 * Deliberately a 2D canvas, NOT a second WebGL context: the 3D graph owns one
 * and live-context caps have evicted contexts in this app before.
 */
const STAR_COUNT = 300;
const DUST_COUNT = 40;
const AMBIENT_ALPHA = 0.85;

export function StarfieldCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const state = createStarfield({ seed: 0xc0ffee, starCount: STAR_COUNT, dustCount: DUST_COUNT, constellations: true });
    // Live media query — the OS setting can change mid-session, and this canvas
    // mounts once for the app's lifetime, so a one-shot sample would either
    // animate forever or stay frozen after a toggle.
    const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
    let reduced = !!media?.matches;

    let w = 0;
    let h = 0;
    const drawStatic = () => {
      ctx.clearRect(0, 0, w, h);
      renderStarfield(ctx, state, w, h, AMBIENT_ALPHA);
    };
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced) drawStatic(); // static frame: stars visible, nothing animates
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let last = performance.now();
    let running = false;
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      stepStarfield(state, dt); // engine clamps dt
      ctx.clearRect(0, 0, w, h);
      renderStarfield(ctx, state, w, h, AMBIENT_ALPHA);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running || reduced) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const onMotionChange = (e: MediaQueryListEvent) => {
      reduced = e.matches;
      if (reduced) {
        stop();
        drawStatic();
      } else if (!document.hidden) {
        start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    media?.addEventListener?.('change', onMotionChange);
    if (!document.hidden) start();
    if (reduced) drawStatic();

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      media?.removeEventListener?.('change', onMotionChange);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="starfield-canvas" aria-hidden="true" />;
}
