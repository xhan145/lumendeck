import type { BackendAdapter, RenderJob, RenderProgressCallback, RenderResult } from './adapter';
import { resolveSeed } from './adapter';
import { buildStreamingPreview } from './preview';

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

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!));
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

  async generate(job: RenderJob, onProgress?: RenderProgressCallback): Promise<RenderResult> {
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
        const progress = i / orbs;
        onProgress({ progress, phase: 'painting', previewDataUrl: buildStreamingPreview(job, progress, 'painting') });
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

    onProgress?.({ progress: 1, phase: 'done', previewDataUrl: canvas.toDataURL('image/png') });
    if (job.output === 'video') {
      const duration = Math.max(0.5, job.frameCount / Math.max(1, job.fps));
      const hueA = Math.floor(rng() * 360);
      const hueB = (hueA + 140) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <defs>
          <radialGradient id="g"><stop offset="0%" stop-color="hsl(${hueA},90%,68%)"/><stop offset="100%" stop-color="hsl(${hueB},80%,16%)"/></radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="hsl(${hueB},65%,12%)"/>
        <circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) * 0.24}" fill="url(#g)" opacity="0.85">
          <animate attributeName="cx" values="${w * 0.35};${w * 0.65};${w * 0.35}" dur="${duration}s" repeatCount="indefinite"/>
          <animate attributeName="r" values="${Math.min(w, h) * 0.18};${Math.min(w, h) * 0.32};${Math.min(w, h) * 0.18}" dur="${duration}s" repeatCount="indefinite"/>
        </circle>
        <text x="24" y="${h - 28}" font-family="system-ui" font-size="18" fill="white" opacity="0.7">${escapeSvgText(job.prompt.slice(0, 80))}</text>
      </svg>`;
      return { dataUrl: svgDataUrl(svg), seed, mediaType: 'video', mimeType: 'image/svg+xml', extension: 'svg' };
    }

    return { dataUrl: canvas.toDataURL('image/png'), seed, mediaType: 'image', mimeType: 'image/png', extension: 'png' };
  }
}
