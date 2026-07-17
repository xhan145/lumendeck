import type { ModelAsset } from '../core/shelf';
import type {
  BackendAdapter,
  EvolveCandidate,
  EvolveStepOptions,
  EvolveStepResult,
  RenderJob,
  RenderMotionOptions,
  RenderProgressCallback,
  RenderResult,
  AnimateStillOptions,
  SvdModelInfo,
} from './adapter';
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
export function resolveBase(url: string): string {
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
  /**
   * Hardware detection fields (additive, best-effort). Populated by the worker's
   * status() VRAM probe; all optional so older bridges and detection failures
   * still yield a valid status. Never blocks launch.
   */
  gpuName?: string;
  totalVramMb?: number;
  freeVramMb?: number;
  computeCapability?: string;
  cudaInitFailed?: boolean;
  bf16Supported?: boolean;
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
  /** injectable fetch (tests); the SVD methods use it so they can be unit-tested. */
  private fetchImpl: typeof fetch;

  constructor(base: string = DEFAULT_BRIDGE_URL, fetchImpl?: typeof fetch) {
    // NOTE: never default to the bare global `fetch` — assigning it to a property
    // and invoking as this.fetchImpl(...) rebinds `this` to the adapter and throws
    // "Illegal invocation" in browsers. Wrap it so `this` stays undefined.
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
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

  /**
   * On-demand ControlNet preprocess preview: extracts the guidance map (edges,
   * depth, pose skeleton, …) for one control image without spending a render.
   * Returns the raw base64 PNG of the map.
   */
  async controlNetPreprocess(req: { type: string; image: string; width?: number; height?: number }): Promise<string> {
    const res = await fetch(`${this.base}/controlnet/preprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = (await res.json().catch(() => null)) as { map_base64?: string; error?: string } | null;
    if (!res.ok || !data?.map_base64) {
      throw new Error(data?.error ?? `Bridge /controlnet/preprocess failed: ${res.status}`);
    }
    return data.map_base64;
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
        fallbackCategory?: string;
        droppedControls?: { type: string; reason: string }[];
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
        fallbackCategory: data.fallbackCategory,
        droppedControls: data.droppedControls,
      };
    } finally {
      polling = false;
    }
  }

  /**
   * Render a motion clip in ONE request: POST /render-motion with the full
   * per-frame job list; the persistent worker loops them (model stays resident),
   * writing {phase:'frame', step, steps} to the per-job progress file. We poll
   * /progress/<jobId> like the /generate path and map the assembled video result.
   * A diffusers-unavailable backend returns procedural frames with fallback:true
   * (surfaced, never silent). Errors surface loudly like /generate.
   */
  async renderMotion(
    jobs: RenderJob[],
    opts: RenderMotionOptions,
    onProgress?: RenderProgressCallback,
  ): Promise<RenderResult> {
    const jobId = opts.jobId
      ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`);
    onProgress?.({ progress: 0.02, phase: 'queued' });

    // Live per-frame progress: poll the bridge's per-job endpoint while the POST
    // is in flight. Best-effort — poll errors are ignored, never fail the render.
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
            onProgress?.({ progress: 0.05, phase: 'loading' });
          } else if (p.phase === 'frame' && p.steps && p.steps > 0) {
            const progress = Math.min(0.97, 0.05 + 0.92 * ((p.step ?? 0) / p.steps));
            onProgress?.({ progress, phase: 'frame', detail: `Frame ${p.step ?? 0}/${p.steps}` });
          }
        } catch {
          // ignore — progress is advisory
        }
      }
    };
    if (polling) void pollLoop();

    try {
      const res = await fetch(`${this.base}/render-motion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs, fps: opts.fps, format: opts.format, jobId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Bridge /render-motion failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        video_base64?: string;
        mediaType?: 'image' | 'video' | 'archive';
        mimeType?: string;
        extension?: string;
        seed: number | string;
        frameCount?: number;
        fps?: number;
        fallback?: boolean;
        fallbackReason?: string;
      };
      if (!data.video_base64) throw new Error('Bridge /render-motion response did not include video data.');
      // The bridge sets mediaType/mimeType/extension per format; these fallbacks
      // only guard an old/partial response.
      const FALLBACK_MIME: Record<string, string> = {
        gif: 'image/gif',
        webm: 'video/webm',
        frames: 'application/zip',
        mp4: 'video/mp4',
      };
      const mediaType = data.mediaType ?? (opts.format === 'frames' ? 'archive' : 'video');
      const mimeType = data.mimeType ?? (FALLBACK_MIME[opts.format] ?? 'video/mp4');
      const extension = data.extension ?? (opts.format === 'gif' ? 'gif' : opts.format);
      const dataUrl = `data:${mimeType};base64,${data.video_base64}`;
      onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
      return {
        dataUrl,
        mediaType,
        mimeType,
        extension,
        // The sequence seed may be numeric or a string tag from the worker; the
        // gallery stores it verbatim, so coerce only the numeric case.
        seed: typeof data.seed === 'number' ? data.seed : Number(data.seed) || 0,
        fallback: data.fallback,
        fallbackReason: data.fallbackReason,
      };
    } finally {
      polling = false;
    }
  }

  async listSvdModels(): Promise<SvdModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.base}/svd-models`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: SvdModelInfo[] };
      return Array.isArray(data.models) ? data.models : [];
    } catch {
      return [];
    }
  }

  async animateStill(imageBase64: string, opts: AnimateStillOptions, onProgress?: RenderProgressCallback): Promise<RenderResult> {
    const jobId = opts.jobId
      ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`);
    onProgress?.({ progress: 0.02, phase: 'queued' });
    let polling = Boolean(onProgress);
    const pollLoop = async () => {
      while (polling) {
        await new Promise((r) => setTimeout(r, 700));
        if (!polling) break;
        try {
          const res = await this.fetchImpl(`${this.base}/progress/${jobId}`, { signal: AbortSignal.timeout(1200) });
          if (!res.ok) continue;
          const p = (await res.json()) as { phase?: string; step?: number; steps?: number };
          if (p.phase === 'loading') onProgress?.({ progress: 0.05, phase: 'loading', detail: 'Loading SVD…' });
          else if (p.phase === 'rendering' && p.steps) onProgress?.({ progress: Math.min(0.95, 0.05 + 0.9 * ((p.step ?? 0) / p.steps)), phase: 'rendering', detail: `Step ${p.step ?? 0}/${p.steps}` });
          else if (p.phase === 'decoding') onProgress?.({ progress: 0.97, phase: 'decoding', detail: 'Decoding frames…' });
        } catch {
          // advisory
        }
      }
    };
    if (polling) void pollLoop();
    try {
      const res = await this.fetchImpl(`${this.base}/animate-svd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Map the UI option names to the worker's clamp keys so the values take effect.
        body: JSON.stringify({ image: imageBase64, modelPath: opts.modelPath, num_frames: opts.frames, fps: opts.fps, motion_bucket_id: opts.motion, seed: opts.seed, jobId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Bridge /animate-svd failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { video_base64?: string; error?: string; mediaType?: 'video'; mimeType?: string; extension?: string; seed?: number | string };
      if (data.error) throw new Error(data.error);
      if (!data.video_base64) throw new Error('Bridge /animate-svd response did not include video data.');
      const mimeType = data.mimeType ?? 'video/mp4';
      const dataUrl = `data:${mimeType};base64,${data.video_base64}`;
      onProgress?.({ progress: 1, phase: 'done', previewDataUrl: dataUrl });
      return { dataUrl, mediaType: 'video', mimeType, extension: data.extension ?? 'mp4', seed: typeof data.seed === 'number' ? data.seed : Number(data.seed) || opts.seed };
    } finally {
      polling = false;
    }
  }

  /**
   * Render + score ONE evolve generation in a single request: POST /evolve-step
   * with the full population job list; the persistent worker renders each (model
   * resident) and the scorer returns per-candidate {score, breakdown}. We poll
   * /progress/<jobId> for {phase:'candidate', step, steps} like /generate and map
   * each `image_base64` to a dataUrl. `clipAvailable=false` + `fallbackReason`
   * pass straight through (loud, never silent). Errors surface loudly like
   * /generate.
   */
  async evolveStep(
    jobs: RenderJob[],
    opts: EvolveStepOptions,
    onProgress?: RenderProgressCallback,
  ): Promise<EvolveStepResult> {
    const jobId = opts.jobId
      ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`);
    onProgress?.({ progress: 0.02, phase: 'queued' });

    // Live per-candidate progress: poll while the POST is in flight. Best-effort —
    // poll errors are ignored and never fail the run.
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
            onProgress?.({ progress: 0.05, phase: 'loading' });
          } else if (p.phase === 'candidate' && p.steps && p.steps > 0) {
            const progress = Math.min(0.97, 0.05 + 0.92 * ((p.step ?? 0) / p.steps));
            onProgress?.({ progress, phase: 'candidate', detail: `Candidate ${p.step ?? 0}/${p.steps}` });
          }
        } catch {
          // ignore — progress is advisory
        }
      }
    };
    if (polling) void pollLoop();

    try {
      const res = await fetch(`${this.base}/evolve-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs, prompt: opts.prompt, weights: opts.weights, jobId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Bridge /evolve-step failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        candidates?: {
          image_base64?: string;
          score?: number;
          breakdown?: { clip?: number | null; aesthetic?: number };
          index?: number;
        }[];
        clipAvailable?: boolean;
        fallbackReason?: string;
      };
      if (!Array.isArray(data.candidates)) {
        throw new Error('Bridge /evolve-step response did not include a candidates array.');
      }
      const candidates: EvolveCandidate[] = data.candidates.map((c, i) => {
        if (!c.image_base64) {
          throw new Error(`Bridge /evolve-step candidate ${i} did not include image data.`);
        }
        const clip = c.breakdown?.clip;
        return {
          dataUrl: `data:image/png;base64,${c.image_base64}`,
          score: Number(c.score ?? 0),
          breakdown: {
            clip: typeof clip === 'number' ? clip : null,
            aesthetic: Number(c.breakdown?.aesthetic ?? 0),
          },
          index: typeof c.index === 'number' ? c.index : i,
        };
      });
      onProgress?.({ progress: 1, phase: 'done' });
      return {
        candidates,
        clipAvailable: data.clipAvailable !== false,
        fallbackReason: data.fallbackReason,
      };
    } finally {
      polling = false;
    }
  }
}
