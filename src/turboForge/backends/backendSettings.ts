import { DEFAULT_COMFY_URL } from '../../bridge/comfyAdapter';

export type RenderBackendId = 'mock' | 'bridge' | 'comfyui';

export interface BackendSettings {
  selectedBackend: RenderBackendId;
  comfyUrl: string;
  bridgeUrl: string;
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
  fallbackToMock: true,
};

export function settingsBackendToTurboBackend(id: RenderBackendId) {
  if (id === 'comfyui') return 'comfyui-api' as const;
  if (id === 'bridge') return 'diffusers' as const;
  return 'mock' as const;
}

export function sanitizeBackendSettings(settings?: Partial<BackendSettings>): BackendSettings {
  return {
    ...DEFAULT_BACKEND_SETTINGS,
    ...settings,
    selectedBackend: settings?.selectedBackend ?? DEFAULT_BACKEND_SETTINGS.selectedBackend,
    comfyUrl: settings?.comfyUrl?.trim() || DEFAULT_BACKEND_SETTINGS.comfyUrl,
    bridgeUrl: settings?.bridgeUrl?.trim() || DEFAULT_BACKEND_SETTINGS.bridgeUrl,
    fallbackToMock: settings?.fallbackToMock ?? DEFAULT_BACKEND_SETTINGS.fallbackToMock,
  };
}
