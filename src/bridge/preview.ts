import type { RenderJob } from './adapter';

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeSvg(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

export function buildStreamingPreview(job: RenderJob, progress: number, phase = 'rendering'): string {
  const p = Math.max(0, Math.min(1, progress));
  const hash = hashString(`${job.prompt}|${job.seed}|${job.width}x${job.height}`);
  const hueA = hash % 360;
  const hueB = (hueA + 116) % 360;
  const hueC = (hueA + 214) % 360;
  const bars = Array.from({ length: 7 }, (_, i) => {
    const x = 22 + i * 28;
    const h = 26 + ((hash >>> (i * 3)) & 31);
    const y = 132 - h * (0.35 + p * 0.65);
    const opacity = 0.28 + p * 0.55;
    return `<rect x="${x}" y="${y.toFixed(1)}" width="17" height="${(132 - y).toFixed(1)}" rx="5" fill="hsl(${(hueA + i * 23) % 360},84%,66%)" opacity="${opacity.toFixed(2)}"/>`;
  }).join('');
  const label = escapeSvg(job.output === 'video' ? 'video preview' : 'image preview');
  const prompt = escapeSvg(job.prompt.slice(0, 44) || 'untitled render');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${hueA},72%,14%)"/>
        <stop offset="1" stop-color="hsl(${hueB},70%,20%)"/>
      </linearGradient>
      <radialGradient id="glow" cx="${25 + p * 55}%" cy="${30 + p * 25}%" r="65%">
        <stop offset="0" stop-color="hsl(${hueC},94%,68%)" stop-opacity="${(0.35 + p * 0.35).toFixed(2)}"/>
        <stop offset="1" stop-color="transparent" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="240" height="160" rx="10" fill="url(#bg)"/>
    <rect width="240" height="160" rx="10" fill="url(#glow)"/>
    ${bars}
    <rect x="18" y="140" width="204" height="5" rx="2.5" fill="rgba(255,255,255,0.16)"/>
    <rect x="18" y="140" width="${(204 * p).toFixed(1)}" height="5" rx="2.5" fill="hsl(${hueC},88%,66%)"/>
    <text x="18" y="24" font-family="Segoe UI, system-ui, sans-serif" font-size="12" fill="white" opacity="0.82">${label}</text>
    <text x="18" y="43" font-family="Segoe UI, system-ui, sans-serif" font-size="11" fill="white" opacity="0.62">${escapeSvg(phase)} ${(p * 100).toFixed(0)}%</text>
    <text x="18" y="124" font-family="Segoe UI, system-ui, sans-serif" font-size="11" fill="white" opacity="0.72">${prompt}</text>
  </svg>`)}`;
}
