import type {
  BackendAdapter,
  EvolveStepOptions,
  EvolveStepResult,
  RenderJob,
  RenderMotionOptions,
  RenderProgressCallback,
  RenderResult,
  AnimateStillOptions,
  SvdModelInfo,
} from './adapter';
import { resolveSeed } from './adapter';
import { buildStreamingPreview } from './preview';
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
          message: `ComfyUI answered /system_stats with HTTP ${res.status}. Confirm the URL, API server, and ComfyUI logs, then open Diagnostics in LumenDeck.`,
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
        message: `ComfyUI ${reason} at ${this.getBaseUrl()}. Start ComfyUI with API access; LumenDeck needs /system_stats, /prompt, /history/{prompt_id}, and /view. Check firewall/CORS, then open Diagnostics.`,
        elapsedMs,
      };
    }
  }

  async ping(): Promise<boolean> {
    return (await this.health()).ok;
  }

  async generate(job: RenderJob, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    const seed = resolveSeed(job.seed);
    const resolvedJob = { ...job, seed };
    const backendStart = performance.now();
    onProgress?.({ progress: 0.05, phase: 'submitting', previewDataUrl: buildStreamingPreview(resolvedJob, 0.05, 'submitting') });
    const prompt = mapComfyTemplate(BASIC_TXT2IMG_TEMPLATE, resolvedJob);
    const submitStarted = performance.now();
    const submit = await fetchWithTimeout(`${this.getBaseUrl()}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: 'lumendeck' }),
    }, 6000);
    if (!submit.ok) {
      const detail = await submit.text().catch(() => '');
      throw new Error(`ComfyUI rejected /prompt (${submit.status}). ${detail.slice(0, 180)} Open Diagnostics and confirm the ComfyUI URL and workflow support.`);
    }
    const queued = (await submit.json()) as { prompt_id?: string };
    if (!queued.prompt_id) throw new Error('ComfyUI /prompt did not return a prompt_id. Check ComfyUI API output and open Diagnostics.');
    onProgress?.({ progress: 0.18, phase: 'queued', previewDataUrl: buildStreamingPreview(resolvedJob, 0.18, 'queued') });

    const queueStart = performance.now();
    const history = await this.pollHistory(queued.prompt_id, (progress) => {
      const overall = 0.18 + progress * 0.62;
      onProgress?.({ progress: overall, phase: 'rendering', previewDataUrl: buildStreamingPreview(resolvedJob, overall, 'rendering') });
    });
    const renderQueueMs = performance.now() - queueStart;
    const image = this.firstImage(history);
    if (!image) throw new Error('ComfyUI /history finished but no image output was found. Check the workflow output node in ComfyUI.');
    onProgress?.({ progress: 0.85, phase: 'fetching output', previewDataUrl: buildStreamingPreview(resolvedJob, 0.85, 'fetching output') });
    const imageUrl = this.imageUrl(image);
    const outputFetchStart = performance.now();
    const imageResponse = await fetchWithTimeout(imageUrl, {}, 10000);
    if (!imageResponse.ok) throw new Error(`ComfyUI /view output fetch failed with HTTP ${imageResponse.status}. Check output permissions and the ComfyUI URL.`);
    const blob = await imageResponse.blob();
    const dataUrl = await blobToDataUrl(blob);
    const outputFetchMs = performance.now() - outputFetchStart;
    const backendRequestMs = performance.now() - backendStart;
    onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
    console.info(`LumenDeck ComfyUI request completed in ${Math.round(performance.now() - submitStarted)} ms`);
    return {
      dataUrl,
      mediaType: 'image',
      mimeType: blob.type || 'image/png',
      extension: blob.type === 'image/webp' ? 'webp' : 'png',
      seed,
      backendTimings: {
        backendRequestMs,
        renderQueueMs,
        outputFetchMs,
        totalRenderMs: backendRequestMs,
      },
    };
  }

  /**
   * Motion-clip rendering is not implemented for the ComfyUI backend: LumenDeck's
   * per-frame sequence render targets the local Diffusers bridge's persistent
   * worker. Throw loudly rather than pretend (no silent fallback).
   */
  async renderMotion(_jobs: RenderJob[], _opts: RenderMotionOptions, _onProgress?: RenderProgressCallback): Promise<RenderResult> {
    throw new Error('Motion-clip rendering is not supported on the ComfyUI backend. Use the local Diffusers bridge or the Mock backend to render a motion clip.');
  }

  async listSvdModels(): Promise<SvdModelInfo[]> {
    return [];
  }

  async animateStill(_imageBase64: string, _opts: AnimateStillOptions): Promise<RenderResult> {
    throw new Error('SVD animate is not supported on the ComfyUI backend yet.');
  }

  /**
   * Auto-Evolve renders + scores a whole population against a CLIP/aesthetic
   * objective in the resident diffusers worker; the ComfyUI backend has no such
   * scorer endpoint. Throw loudly rather than pretend (no silent fallback).
   */
  async evolveStep(_jobs: RenderJob[], _opts: EvolveStepOptions, _onProgress?: RenderProgressCallback): Promise<EvolveStepResult> {
    throw new Error('Auto-Evolve is not supported on the ComfyUI backend. Use the local Diffusers bridge (or the Mock backend for a procedural preview).');
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
    throw new Error('Timed out waiting for ComfyUI /history/{prompt_id}. The render may still be running in ComfyUI; open Diagnostics and check the ComfyUI server.');
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
