import { useEffect, useRef } from 'react';
import { BrandMark } from '../components/icons';
import {
  buildChain,
  createStarfield,
  renderStarfield,
  splashPhase,
  stepStarfield,
  SPLASH_TOTAL_MS,
} from './starfield/engine';

/**
 * Launch splash — plays fully on EVERY launch (~2.45s): deep space fades in,
 * stars twinkle in, a constellation draws itself, the wordmark glows in, then
 * the whole overlay lifts away revealing the app (whose ambient starfield is
 * the same visual language, so the splash reads as dissolving into the app).
 *
 * The app boots behind it (bridge probing etc. is untouched) — no added
 * startup latency. Reduced motion: static logo + stars, one 800ms fade.
 */
const SPLASH_STARS = 340;
const SPLASH_DUST = 30;
const REDUCED_SPLASH_MS = 800;

export function SplashScreen({ onDone }: { onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markRef = useRef<HTMLDivElement | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const mark = markRef.current;
    if (!root || !canvas || !mark) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      onDoneRef.current();
      return;
    }
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Splash drives its constellation manually (constellations: false stops the
    // engine's own lifecycle from competing with the choreography).
    const state = createStarfield({ seed: 0x57a9f1e1, starCount: SPLASH_STARS, dustCount: SPLASH_DUST, constellations: false });
    // A guaranteed constellation near the center: anchor = the most central star.
    let anchor = 0;
    let bestD = Infinity;
    for (let i = 0; i < state.stars.length; i++) {
      const dx = state.stars[i].x - 0.5;
      const dy = state.stars[i].y - 0.42;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        anchor = i;
      }
    }
    const chain = buildChain(state.stars, anchor, 6);

    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    if (reduced) {
      // Static: stars + logo, one gentle fade, done quickly.
      state.constellation = { chain, stage: 'holding', progress: 1, stageLeft: 1 };
      renderStarfield(ctx, state, w, h, 1);
      mark.style.opacity = '1';
      root.classList.add('splash-fade');
      const t = window.setTimeout(() => onDoneRef.current(), REDUCED_SPLASH_MS);
      return () => {
        window.clearTimeout(t);
        window.removeEventListener('resize', resize);
      };
    }

    let raf = 0;
    let finished = false;
    const start = performance.now();
    let last = start;
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const phase = splashPhase(now - start);
      stepStarfield(state, dt);
      // Choreographed constellation: progress driven by the phase curve.
      state.constellation = phase.linesProgress > 0
        ? { chain, stage: 'drawing', progress: phase.linesProgress, stageLeft: 0 }
        : null;
      ctx.clearRect(0, 0, w, h);
      renderStarfield(ctx, state, w, h, phase.starsAlpha);
      mark.style.opacity = String(phase.wordmarkAlpha);
      mark.style.transform = `scale(${0.94 + 0.06 * phase.wordmarkAlpha})`;
      root.style.opacity = String(1 - phase.liftT);
      root.style.transform = `translateY(${-40 * phase.liftT}px)`;
      if (phase.done) {
        if (!finished) {
          finished = true;
          onDoneRef.current();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // Safety: if rAF is starved (hidden/occluded launch), never trap the user
    // behind the splash — finish on a wall-clock timer regardless.
    const failsafe = window.setTimeout(() => {
      if (!finished) {
        finished = true;
        onDoneRef.current();
      }
    }, SPLASH_TOTAL_MS + 600);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(failsafe);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div ref={rootRef} className="splash-root" role="status" aria-label="LumenDeck is starting">
      <canvas ref={canvasRef} className="splash-canvas" aria-hidden="true" />
      <div ref={markRef} className="splash-mark">
        <BrandMark size={44} />
        <div className="splash-word">
          <span className="lumen">Lumen</span><span className="deck">Deck</span>
        </div>
        <div className="splash-tag">a constellation of your ideas</div>
      </div>
    </div>
  );
}
