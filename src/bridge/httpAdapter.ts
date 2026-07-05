import type { ModelAsset } from '../core/shelf';
import type { BackendAdapter, RenderJob, RenderProgressCallback, RenderResult } from './adapter';
import { buildStreamingPreview } from './preview';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8787';

function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/**
 * Resolve the base URL for bridge calls.
 * - Web (dev server or bridge-served): same-origin ('') — the Vite proxy or the
 *   bridge's own static server routes /health etc. to the bridge. No cross-origin.
 * - Tauri desktop: the loopback address, since the UI is loaded from tauri://.
 * - A custom, non-default URL is always honored (remote bridge).
 */
function resolveBase(url: string): string {
  const trimmed = (url || '').trim().replace(/\/+$/, '');
  if (trimmed && trimmed !== DEFAULT_BRIDGE_URL) return trimmed;
  return isTauri() ? DEFAULT_BRIDGE_URL : '';
}

export interface CivitaiResult {
  modelId: number;
  name: string;
  type: string;
  nsfw: boolean;
  baseModel: string;
  versionId: number;
  fileName: string;
  sizeKB: number;
  downloadUrl: string;
  thumbnail: string;
  downloads: number;
}

export interface BridgeModelStatus {
  modelId: string;
  dependenciesReady: boolean;
  loaded: boolean;
  modelCached: boolean | null;
  device: string;
  cuda: boolean;
  cacheDir: string;
  installCommand: string;
  installable?: boolean;
  managedRuntime?: {
    path?: string;
    python?: string;
    exists?: boolean;
    loaded?: boolean;
    installer?: { cmd: string[]; version: string } | null;
  };
  message: string;
  dependencies?: Record<string, unknown>;
}

export interface BridgeModelFolderStatus {
  configured: string;
  active: string;
  assetCount: number;
  checkpointCount: number;
  loraCount: number;
  usingDemo: boolean;
  candidates: string[];
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
    this.base = resolveBase(url);
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

  async civitaiSearch(query: string, type: 'Checkpoint' | 'LORA', token = ''): Promise<CivitaiResult[]> {
    const params = new URLSearchParams({ query, type });
    if (token) params.set('token', token);
    const res = await fetch(`${this.base}/civitai/search?${params.toString()}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error ?? `Civitai search failed: ${res.status}`);
    }
    return ((await res.json()) as { items: CivitaiResult[] }).items;
  }

  async civitaiDownload(
    item: CivitaiResult,
    token: string,
    onProgress?: (received: number, total: number) => void,
  ): Promise<{ path: string; bytes: number }> {
    const jobId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
    const assetType = item.type === 'LORA' ? 'lora' : 'checkpoint';
    let polling = Boolean(onProgress);
    const poll = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 700));
        if (!polling) break;
        try {
          const res = await fetch(`${this.base}/progress/${jobId}`, { signal: AbortSignal.timeout(1500) });
          if (!res.ok) continue;
          const p = (await res.json()) as { phase?: string; received?: number; total?: number };
          if (p.phase === 'downloading') onProgress?.(p.received ?? 0, p.total ?? 0);
        } catch { /* advisory */ }
      }
    };
    if (polling) void poll();
    try {
      const res = await fetch(`${this.base}/civitai/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadUrl: item.downloadUrl, fileName: item.fileName, assetType, token, jobId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? `Download failed: ${res.status}`);
      }
      return (await res.json()) as { path: string; bytes: number };
    } finally {
      polling = false;
    }
  }

  async diffusersStatus(): Promise<BridgeModelStatus> {
    const res = await fetch(`${this.base}/diffusers/status`);
    if (!res.ok) throw new Error(`Bridge /diffusers/status failed: ${res.status}`);
    return (await res.json()) as BridgeModelStatus;
  }

  async modelFolderStatus(): Promise<BridgeModelFolderStatus> {
    const res = await fetch(`${this.base}/model-folder`);
    if (!res.ok) throw new Error(`Bridge /model-folder failed: ${res.status}`);
    return (await res.json()) as BridgeModelFolderStatus;
  }

  async setModelFolder(path: string): Promise<BridgeModelFolderStatus> {
    const res = await fetch(`${this.base}/model-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string; status?: BridgeModelFolderStatus } | null;
      const message = data?.error ?? `Bridge /model-folder failed: ${res.status}`;
      throw Object.assign(new Error(message), { status: data?.status });
    }
    return (await res.json()) as BridgeModelFolderStatus;
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

  async installDiffusersRuntime(): Promise<BridgeModelStatus> {
    const res = await fetch(`${this.base}/diffusers/install`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string; status?: BridgeModelStatus } | null;
      const message = data?.error ?? `Bridge /diffusers/install failed: ${res.status}`;
      throw Object.assign(new Error(message), { status: data?.status });
    }
    return (await res.json()) as BridgeModelStatus;
  }

  async generate(job: RenderJob, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    onProgress?.({ progress: 0.05, phase: 'queued', previewDataUrl: buildStreamingPreview(job, 0.05, 'queued') });
    const jobId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;

    // Live progress: poll the bridge's per-job endpoint while the POST is in flight.
    // Best-effort — poll errors are ignored and never fail the render.
    let polling = Boolean(onProgress);
    const pollLoop = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 600));
        if (!polling) break;
        try {
          const res = await fetch(`${this.base}/progress/${jobId}`, { signal: AbortSignal.timeout(1200) });
          if (!res.ok) continue;
          const p = (await res.json()) as { phase?: string; step?: number; steps?: number };
          if (p.phase === 'loading') {
            onProgress?.({ progress: 0.1, phase: 'loading', previewDataUrl: buildStreamingPreview(job, 0.1, 'loading') });
          }
          else if (p.phase === 'rendering' && p.steps && p.steps > 0) {
            const progress = Math.min(0.95, 0.15 + 0.8 * ((p.step ?? 0) / p.steps));
            onProgress?.({ progress, phase: 'rendering', previewDataUrl: buildStreamingPreview(job, progress, 'rendering') });
          }
        } catch {
          // ignore — progress is advisory
        }
      }
    };
    if (polling) void pollLoop();

    try {
      const res = await fetch(`${this.base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...job, renderer: this.renderer, jobId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Bridge /generate failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        image_base64?: string;
        video_base64?: string;
        mediaType?: 'image' | 'video';
        mimeType?: string;
        extension?: string;
        seed: number;
        fallback?: boolean;
        fallbackReason?: string;
      };
      const mediaType = data.mediaType ?? (data.video_base64 ? 'video' : 'image');
      const mimeType = data.mimeType ?? (mediaType === 'video' ? 'image/gif' : 'image/png');
      const payload = data.video_base64 ?? data.image_base64;
      if (!payload) throw new Error('Bridge /generate response did not include media data.');
      const dataUrl = `data:${mimeType};base64,${payload}`;
      onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
      return {
        dataUrl,
        mediaType,
        mimeType,
        extension: data.extension ?? (mimeType === 'image/gif' ? 'gif' : 'png'),
        seed: data.seed,
        fallback: data.fallback,
        fallbackReason: data.fallbackReason,
      };
    } finally {
      polling = false;
    }
  }
}
