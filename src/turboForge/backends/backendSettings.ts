import { DEFAULT_COMFY_URL } from '../../bridge/comfyAdapter';

export type RenderBackendId = 'mock' | 'bridge' | 'comfyui' | 'cloud';

export type BridgeRenderer = 'procedural' | 'diffusers' | 'auto';

const BRIDGE_RENDERERS: BridgeRenderer[] = ['procedural', 'diffusers', 'auto'];

export interface BackendSettings {
  selectedBackend: RenderBackendId;
  comfyUrl: string;
  bridgeUrl: string;
  /** Which renderer the local bridge should use: procedural | diffusers | auto. */
  bridgeRenderer: BridgeRenderer;
  /** Hosted provider id for the Cloud backend (keys live on the bridge, not here). */
  cloudProvider: string;
  /** Curated model id within the chosen cloud provider. */
  cloudModel: string;
  fallbackToMock: boolean;
  lastHealth?: {
    backend: RenderBackendId;
    ok: boolean;
    status: 'healthy' | 'unavailable' | 'degraded';
    message: string;
    elapsedMs: number;
    checkedAt: string;
  };
}

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  selectedBackend: 'mock',
  comfyUrl: DEFAULT_COMFY_URL,
  bridgeUrl: 'http://127.0.0.1:8787',
  bridgeRenderer: 'auto',
  cloudProvider: 'openai',
  cloudModel: '',
  fallbackToMock: true,
};

export function settingsBackendToTurboBackend(id: RenderBackendId) {
  if (id === 'comfyui') return 'comfyui-api' as const;
  if (id === 'bridge') return 'diffusers' as const;
  if (id === 'cloud') return 'future-cloud' as const;
  return 'mock' as const;
}

export function sanitizeBackendSettings(settings?: Partial<BackendSettings>): BackendSettings {
  return {
    ...DEFAULT_BACKEND_SETTINGS,
    ...settings,
    selectedBackend: settings?.selectedBackend ?? DEFAULT_BACKEND_SETTINGS.selectedBackend,
    comfyUrl: settings?.comfyUrl?.trim() || DEFAULT_BACKEND_SETTINGS.comfyUrl,
    bridgeUrl: settings?.bridgeUrl?.trim() || DEFAULT_BACKEND_SETTINGS.bridgeUrl,
    bridgeRenderer: BRIDGE_RENDERERS.includes(settings?.bridgeRenderer as BridgeRenderer)
      ? (settings!.bridgeRenderer as BridgeRenderer)
      : DEFAULT_BACKEND_SETTINGS.bridgeRenderer,
    cloudProvider: (settings?.cloudProvider ?? '').trim() || DEFAULT_BACKEND_SETTINGS.cloudProvider,
    cloudModel: (settings?.cloudModel ?? '').trim(),
    fallbackToMock: settings?.fallbackToMock ?? DEFAULT_BACKEND_SETTINGS.fallbackToMock,
  };
}
