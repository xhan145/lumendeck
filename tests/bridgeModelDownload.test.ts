import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpAdapter, type BridgeModelStatus } from '../src/bridge/httpAdapter';
import { useStudio } from '../src/state/store';
import { sanitizeBackendSettings } from '../src/turboForge/backends/backendSettings';

const READY_STATUS: BridgeModelStatus = {
  modelId: 'stabilityai/sd-turbo',
  dependenciesReady: true,
  loaded: true,
  modelCached: true,
  device: 'cpu',
  cuda: false,
  cacheDir: 'C:/Users/example/.cache/huggingface',
  installCommand: 'python -m pip install torch diffusers transformers accelerate',
  message: 'ready',
};

describe('bridge model management', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches Diffusers status from the bridge', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(READY_STATUS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpAdapter('http://bridge.local///');

    const status = await adapter.diffusersStatus();

    expect(status.modelId).toBe('stabilityai/sd-turbo');
    expect(fetchMock).toHaveBeenCalledWith('http://bridge.local/diffusers/status');
  });

  it('surfaces download errors with bridge status payloads', async () => {
    const missingStatus = { ...READY_STATUS, dependenciesReady: false, loaded: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'missing torch', status: missingStatus }), { status: 503 })));
    const adapter = new HttpAdapter('http://bridge.local');

    await expect(adapter.downloadDiffusersModel()).rejects.toMatchObject({
      message: 'missing torch',
      status: missingStatus,
    });
  });

  it('stores a successful model download and selects real Diffusers rendering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(READY_STATUS), { status: 200 })));
    useStudio.setState({
      adapterId: 'bridge',
      turboBackendId: 'diffusers',
      bridgeModelStatus: null,
      bridgeModelBusy: false,
      bridgeModelError: null,
      backendSettings: sanitizeBackendSettings({
        selectedBackend: 'bridge',
        bridgeUrl: 'http://bridge.local',
        bridgeRenderer: 'auto',
      }),
    });

    await useStudio.getState().downloadBridgeModel();

    const state = useStudio.getState();
    expect(state.bridgeModelStatus?.loaded).toBe(true);
    expect(state.bridgeModelBusy).toBe(false);
    expect(state.bridgeModelError).toBeNull();
    expect(state.backendSettings.bridgeRenderer).toBe('diffusers');
  });
});
