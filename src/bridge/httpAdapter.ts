import type { ModelAsset } from '../core/shelf';
import type { BackendAdapter, RenderJob, RenderResult } from './adapter';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';

/**
 * Client for the local Python FastAPI render bridge (see bridge/README.md).
 * The bridge serves /health, /models (local scanner) and /generate.
 */
export class HttpAdapter implements BackendAdapter {
  id = 'bridge';
  label = 'Local bridge (FastAPI)';

  constructor(private base: string = DEFAULT_BRIDGE_URL) {}

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelAsset[]> {
    const res = await fetch(`${this.base}/models`);
    if (!res.ok) throw new Error(`Bridge /models failed: ${res.status}`);
    return (await res.json()) as ModelAsset[];
  }

  async generate(job: RenderJob, onProgress?: (p: number) => void): Promise<RenderResult> {
    onProgress?.(0.05);
    const res = await fetch(`${this.base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bridge /generate failed (${res.status}): ${text.slice(0, 200)}`);
    }
    onProgress?.(0.9);
    const data = (await res.json()) as { image_base64: string; seed: number };
    onProgress?.(1);
    return { dataUrl: `data:image/png;base64,${data.image_base64}`, seed: data.seed };
  }
}
