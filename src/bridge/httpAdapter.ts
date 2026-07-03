import type { ModelAsset } from '../core/shelf';
import type { BackendAdapter, RenderJob, RenderResult } from './adapter';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';

export interface BridgeModelStatus {
  modelId: string;
  dependenciesReady: boolean;
  loaded: boolean;
  modelCached: boolean | null;
  device: string;
  cuda: boolean;
  cacheDir: string;
  installCommand: string;
  message: string;
  dependencies?: Record<string, unknown>;
}

/**
 * Client for the local Python render bridge (see bridge/README.md).
 * The bridge serves /health, /models (local scanner), /generate, and optional
 * Diffusers model-management endpoints.
 */
export class HttpAdapter implements BackendAdapter {
  id = 'bridge';
  label = 'Local bridge';
  private renderer: string = 'auto';
  private base = DEFAULT_BRIDGE_URL;

  constructor(base: string = DEFAULT_BRIDGE_URL) {
    this.setBaseUrl(base);
  }

  setBaseUrl(url: string): void {
    this.base = url.trim().replace(/\/+$/, '') || DEFAULT_BRIDGE_URL;
  }

  /** Which bridge renderer to request: 'procedural' | 'diffusers' | 'auto'. */
  setRenderer(mode: string): void {
    this.renderer = mode;
  }

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

  async diffusersStatus(): Promise<BridgeModelStatus> {
    const res = await fetch(`${this.base}/diffusers/status`);
    if (!res.ok) throw new Error(`Bridge /diffusers/status failed: ${res.status}`);
    return (await res.json()) as BridgeModelStatus;
  }

  async downloadDiffusersModel(): Promise<BridgeModelStatus> {
    const res = await fetch(`${this.base}/diffusers/download`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string; status?: BridgeModelStatus } | null;
      const message = data?.error ?? `Bridge /diffusers/download failed: ${res.status}`;
      throw Object.assign(new Error(message), { status: data?.status });
    }
    return (await res.json()) as BridgeModelStatus;
  }

  async generate(job: RenderJob, onProgress?: (p: number) => void): Promise<RenderResult> {
    onProgress?.(0.05);
    const res = await fetch(`${this.base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...job, renderer: this.renderer }),
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
