import type {
  BackendAdapter,
  EvolveStepResult,
  RenderJob,
  RenderProgressCallback,
  RenderResult,
  SvdModelInfo,
} from './adapter';
import { DEFAULT_BRIDGE_URL, resolveBase } from './httpAdapter';

/** One curated model offered by a cloud provider. */
export interface CloudModelInfo {
  id: string;
  label: string;
  kind: 'image' | 'video';
}

/** One hosted provider as reported by GET /cloud/providers. */
export interface CloudProviderInfo {
  id: string;
  label: string;
  kind: 'image' | 'video' | 'both';
  models: CloudModelInfo[];
  /** true when the bridge has an API key saved for this provider (value never leaves the bridge). */
  hasKey: boolean;
}

const NOT_ON_CLOUD =
  'is not available on the Cloud backend — switch Backend to the local Diffusers bridge. The Cloud backend renders single images/videos only.';

/**
 * Hosted-API backend. All provider HTTP happens on the local bridge
 * (/cloud/generate) so API keys never touch the browser; this adapter only
 * talks to the bridge and mirrors HttpAdapter's progress polling + result
 * mapping. SVD/evolve/motion are LOUDLY unsupported (never a fake).
 */
export class CloudAdapter implements BackendAdapter {
  id = 'cloud';
  label = 'Cloud (hosted APIs)';
  private base = DEFAULT_BRIDGE_URL;
  private provider = 'openai';
  private model = '';
  private fetchImpl: typeof fetch;

  constructor(base: string = DEFAULT_BRIDGE_URL, fetchImpl?: typeof fetch) {
    // Wrap the global fetch so `this` stays undefined (see the httpAdapter note).
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.setBaseUrl(base);
  }

  setBaseUrl(url: string): void {
    this.base = resolveBase(url);
  }

  setProvider(provider: string): void {
    this.provider = provider;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/cloud/providers`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listProviders(): Promise<CloudProviderInfo[]> {
    const res = await this.fetchImpl(`${this.base}/cloud/providers`);
    const data = (await res.json().catch(() => null)) as { providers?: CloudProviderInfo[]; error?: string } | null;
    if (!res.ok || !data?.providers) {
      throw new Error(data?.error ?? `Bridge /cloud/providers failed: ${res.status}`);
    }
    return data.providers;
  }

  /** Persist (or clear, with an empty string) a provider key on the bridge. */
  async saveKey(provider: string, key: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.base}/cloud/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; hasKey?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error ?? `Bridge /cloud/keys failed: ${res.status}`);
    return Boolean(data.hasKey);
  }

  async generate(job: RenderJob, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    onProgress?.({ progress: 0.05, phase: 'queued' });
    const jobId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;

    // Live progress: poll the bridge's per-job endpoint while the POST is in
    // flight (the bridge maps provider polls onto {phase, step, steps}).
    // Best-effort — poll errors are ignored and never fail the render.
    let polling = Boolean(onProgress);
    const pollLoop = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 600));
        if (!polling) break;
        try {
          const res = await this.fetchImpl(`${this.base}/progress/${jobId}`, { signal: AbortSignal.timeout(1200) });
          if (!res.ok) continue;
          const p = (await res.json()) as { phase?: string; step?: number; steps?: number };
          if (p.phase === 'loading') onProgress?.({ progress: 0.1, phase: 'queued' });
          else if (p.phase === 'rendering' && p.steps && p.steps > 0) {
            const progress = Math.min(0.95, 0.15 + 0.8 * ((p.step ?? 0) / p.steps));
            onProgress?.({ progress, phase: 'rendering' });
          }
        } catch {
          // ignore — progress is advisory
        }
      }
    };
    if (polling) void pollLoop();

    try {
      const res = await this.fetchImpl(`${this.base}/cloud/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...job, provider: this.provider, model: this.model, jobId }),
      });
      const data = (await res.json().catch(() => null)) as {
        image_base64?: string;
        video_base64?: string;
        mediaType?: 'image' | 'video';
        mimeType?: string;
        extension?: string;
        seed?: number | string;
        error?: string;
      } | null;
      if (!res.ok || !data || data.error) {
        throw new Error(data?.error ?? `Cloud render failed (${res.status}).`);
      }
      const mediaType = data.mediaType ?? (data.video_base64 ? 'video' : 'image');
      const mimeType = data.mimeType ?? (mediaType === 'video' ? 'video/mp4' : 'image/png');
      const payload = data.video_base64 ?? data.image_base64;
      if (!payload) throw new Error('Cloud render response did not include media data.');
      const dataUrl = `data:${mimeType};base64,${payload}`;
      onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
      return {
        dataUrl,
        mediaType,
        mimeType,
        extension: data.extension ?? (mediaType === 'video' ? 'mp4' : 'png'),
        seed: typeof data.seed === 'number' ? data.seed : Number(data.seed) || job.seed,
      };
    } finally {
      polling = false;
    }
  }

  async renderMotion(): Promise<RenderResult> {
    throw new Error(`Motion-clip rendering ${NOT_ON_CLOUD}`);
  }

  async animateStill(): Promise<RenderResult> {
    throw new Error(`SVD animation ${NOT_ON_CLOUD}`);
  }

  async evolveStep(): Promise<EvolveStepResult> {
    throw new Error(`Auto-Evolve ${NOT_ON_CLOUD}`);
  }

  async listSvdModels(): Promise<SvdModelInfo[]> {
    return [];
  }
}
