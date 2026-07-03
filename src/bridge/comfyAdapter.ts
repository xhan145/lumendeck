import type { BackendAdapter, RenderJob, RenderResult } from './adapter';
import { resolveSeed } from './adapter';
import { BASIC_TXT2IMG_TEMPLATE } from '../turboForge/workflows/comfyWorkflowTemplates';
import { mapComfyTemplate } from '../turboForge/workflows/templateMapper';

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';

export interface ComfyHealthResult {
  ok: boolean;
  status: 'healthy' | 'unavailable' | 'degraded';
  message: string;
  elapsedMs: number;
}

interface ComfyHistoryOutput {
  images?: { filename: string; subfolder?: string; type?: string }[];
}

interface ComfyHistoryEntry {
  outputs?: Record<string, ComfyHistoryOutput>;
  status?: { completed?: boolean; status_str?: string };
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || DEFAULT_COMFY_URL;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 4000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class ComfyAdapter implements BackendAdapter {
  id = 'comfyui';
  label = 'ComfyUI API';

  constructor(private baseUrl: string = DEFAULT_COMFY_URL) {}

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = cleanBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return cleanBaseUrl(this.baseUrl);
  }

  async health(): Promise<ComfyHealthResult> {
    const started = performance.now();
    try {
      const res = await fetchWithTimeout(`${this.getBaseUrl()}/system_stats`, {}, 3000);
      const elapsedMs = performance.now() - started;
      if (!res.ok) {
        return {
          ok: false,
          status: 'degraded',
          message: `ComfyUI answered /system_stats with HTTP ${res.status}. Check the URL and ComfyUI logs.`,
          elapsedMs,
        };
      }
      return {
        ok: true,
        status: 'healthy',
        message: `Connected to ComfyUI at ${this.getBaseUrl()}.`,
        elapsedMs,
      };
    } catch (error) {
      const elapsedMs = performance.now() - started;
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'could not be reached';
      return {
        ok: false,
        status: 'unavailable',
        message: `ComfyUI ${reason}. Start ComfyUI with API access, then check the URL and browser CORS/network permissions.`,
        elapsedMs,
      };
    }
  }

  async ping(): Promise<boolean> {
    return (await this.health()).ok;
  }

  async generate(job: RenderJob, onProgress?: (p: number) => void): Promise<RenderResult> {
    const seed = resolveSeed(job.seed);
    const resolvedJob = { ...job, seed };
    const backendStart = performance.now();
    onProgress?.(0.05);
    const prompt = mapComfyTemplate(BASIC_TXT2IMG_TEMPLATE, resolvedJob);
    const submitStarted = performance.now();
    const submit = await fetchWithTimeout(`${this.getBaseUrl()}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: 'lumendeck' }),
    }, 6000);
    if (!submit.ok) {
      const detail = await submit.text().catch(() => '');
      throw new Error(`ComfyUI rejected the workflow (${submit.status}). ${detail.slice(0, 180)}`);
    }
    const queued = (await submit.json()) as { prompt_id?: string };
    if (!queued.prompt_id) throw new Error('ComfyUI did not return a prompt_id.');
    onProgress?.(0.18);

    const queueStart = performance.now();
    const history = await this.pollHistory(queued.prompt_id, (progress) => onProgress?.(0.18 + progress * 0.62));
    const renderQueueMs = performance.now() - queueStart;
    const image = this.firstImage(history);
    if (!image) throw new Error('ComfyUI finished but no image output was found in history.');
    onProgress?.(0.85);
    const imageUrl = this.imageUrl(image);
    const outputFetchStart = performance.now();
    const imageResponse = await fetchWithTimeout(imageUrl, {}, 10000);
    if (!imageResponse.ok) throw new Error(`ComfyUI output fetch failed with HTTP ${imageResponse.status}.`);
    const blob = await imageResponse.blob();
    const dataUrl = await blobToDataUrl(blob);
    const outputFetchMs = performance.now() - outputFetchStart;
    const backendRequestMs = performance.now() - backendStart;
    onProgress?.(1);
    console.info(`LumenDeck ComfyUI request completed in ${Math.round(performance.now() - submitStarted)} ms`);
    return {
      dataUrl,
      seed,
      backendTimings: {
        backendRequestMs,
        renderQueueMs,
        outputFetchMs,
        totalRenderMs: backendRequestMs,
      },
    };
  }

  private async pollHistory(promptId: string, onProgress?: (progress: number) => void): Promise<ComfyHistoryEntry> {
    const started = Date.now();
    const timeoutMs = 10 * 60 * 1000;
    let attempts = 0;
    while (Date.now() - started < timeoutMs) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, attempts < 3 ? 500 : 1500));
      const res = await fetchWithTimeout(`${this.getBaseUrl()}/history/${encodeURIComponent(promptId)}`, {}, 5000);
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = data[promptId];
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) return entry;
      onProgress?.(Math.min(0.95, attempts / 60));
    }
    throw new Error('Timed out waiting for ComfyUI history. The render may still be running in ComfyUI.');
  }

  private firstImage(history: ComfyHistoryEntry): { filename: string; subfolder?: string; type?: string } | null {
    for (const output of Object.values(history.outputs ?? {})) {
      const image = output.images?.[0];
      if (image?.filename) return image;
    }
    return null;
  }

  private imageUrl(image: { filename: string; subfolder?: string; type?: string }): string {
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    });
    return `${this.getBaseUrl()}/view?${params.toString()}`;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read ComfyUI image output.'));
    reader.readAsDataURL(blob);
  });
}
