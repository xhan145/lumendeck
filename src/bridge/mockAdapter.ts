import type { BackendAdapter, RenderJob, RenderResult } from './adapter';
import { resolveSeed } from './adapter';

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * In-browser procedural renderer. Always available, fully offline, and
 * deterministic per (seed, prompt, size) — a stand-in diffusion path that
 * exercises the full job → image → gallery pipeline.
 */
export class MockAdapter implements BackendAdapter {
  id = 'mock';
  label = 'Procedural (built-in)';

  async ping(): Promise<boolean> {
    return true;
  }

  async generate(job: RenderJob, onProgress?: (p: number) => void): Promise<RenderResult> {
    const seed = resolveSeed(job.seed);
    const rng = mulberry32(seed ^ hashString(job.prompt));
    const w = Math.max(64, Math.min(2048, job.width));
    const h = Math.max(64, Math.min(2048, job.height));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Palette derived from prompt hash + brand hues
    const hueA = Math.floor(rng() * 360);
    const hueB = (hueA + 120 + Math.floor(rng() * 90)) % 360;
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hueA} 70% 14%)`);
    grad.addColorStop(1, `hsl(${hueB} 65% 22%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Layered glow orbs — density scales with steps, spread with cfg
    const orbs = Math.min(140, 20 + job.steps * 2);
    for (let i = 0; i < orbs; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const r = (0.02 + rng() * 0.12 * Math.min(3, job.cfg / 5)) * Math.min(w, h);
      const hue = rng() > 0.5 ? hueA : hueB;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${hue} 90% 65% / 0.55)`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (onProgress && i % 10 === 0) {
        onProgress(i / orbs);
        await new Promise((res) => setTimeout(res, 8));
      }
    }

    // LoRA influence: each enabled LoRA adds a signature ring pattern
    job.loras.forEach((lora, idx) => {
      ctx.strokeStyle = `hsla(${(hueA + idx * 47) % 360} 85% 70% / ${Math.min(0.8, Math.abs(lora.weight) * 0.4)})`;
      ctx.lineWidth = 2 + idx;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) * (0.18 + idx * 0.09), 0, Math.PI * 2);
      ctx.stroke();
    });

    onProgress?.(1);
    return { dataUrl: canvas.toDataURL('image/png'), seed };
  }
}
