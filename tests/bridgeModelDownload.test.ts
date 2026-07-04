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
  installCommand: 'python -m pip install torch numpy==1.26.4 diffusers==0.30.3 transformers==4.44.2 tokenizers==0.19.1 accelerate safetensors kornia',
  installable: true,
  managedRuntime: {
    path: 'C:/Users/example/AppData/Local/LumenDeck/diffusers-runtime',
    python: 'C:/Users/example/AppData/Local/LumenDeck/diffusers-runtime/Scripts/python.exe',
    exists: true,
    loaded: true,
    installer: { cmd: ['py', '-3.12'], version: '3.12.8' },
  },
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

  it('installs the managed Diffusers runtime through the bridge', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(READY_STATUS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpAdapter('http://bridge.local');

    const status = await adapter.installDiffusersRuntime();

    expect(status.loaded).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://bridge.local/diffusers/install', { method: 'POST' });
  });

  it('sets a local model folder through the bridge', async () => {
    const folderStatus = {
      configured: 'D:/models',
      active: 'D:/models',
      assetCount: 2,
      checkpointCount: 1,
      loraCount: 1,
      usingDemo: false,
      candidates: ['D:/models'],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(folderStatus), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new HttpAdapter('http://bridge.local');

    const status = await adapter.setModelFolder('D:/models');

    expect(status.checkpointCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith('http://bridge.local/model-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'D:/models' }),
    });
  });

  it('surfaces model folder errors with bridge status payloads', async () => {
    const status = { configured: '', active: '', assetCount: 0, checkpointCount: 0, loraCount: 0, usingDemo: true, candidates: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Folder does not exist', status }), { status: 400 })));
    const adapter = new HttpAdapter('http://bridge.local');

    await expect(adapter.setModelFolder('Z:/missing')).rejects.toMatchObject({
      message: 'Folder does not exist',
      status,
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

  it('stores a successful runtime install and selects real Diffusers rendering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(READY_STATUS), { status: 200 })));
    useStudio.setState({
      adapterId: 'mock',
      turboBackendId: 'mock',
      bridgeModelStatus: null,
      bridgeModelBusy: false,
      bridgeModelError: null,
      backendSettings: sanitizeBackendSettings({
        selectedBackend: 'mock',
        bridgeUrl: 'http://bridge.local',
        bridgeRenderer: 'auto',
      }),
    });

    await useStudio.getState().installBridgeRuntime();

    const state = useStudio.getState();
    expect(state.adapterId).toBe('bridge');
    expect(state.bridgeModelStatus?.managedRuntime?.exists).toBe(true);
    expect(state.backendSettings.selectedBackend).toBe('bridge');
    expect(state.backendSettings.bridgeRenderer).toBe('diffusers');
  });
});
