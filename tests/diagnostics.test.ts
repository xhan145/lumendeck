import { describe, expect, it } from 'vitest';
import { formatDiagnosticsReport, redactSecrets } from '../src/core/diagnostics';
import { DEFAULT_BACKEND_SETTINGS } from '../src/turboForge/backends/backendSettings';

describe('diagnostics report', () => {
  it('redacts common token patterns', () => {
    expect(redactSecrets('hf_abc123 token=secret key=another')).not.toContain('hf_abc123');
    expect(redactSecrets('hf_abc123 token=secret key=another')).not.toContain('secret');
    expect(redactSecrets('hf_abc123 token=secret key=another')).not.toContain('another');
  });

  it('includes backend, cuda, storage, and fallback fields', () => {
    const report = formatDiagnosticsReport({
      appVersion: '0.2.0',
      now: new Date('2026-07-06T12:00:00Z'),
      selectedBackend: 'bridge',
      bridgeOnline: false,
      backendSettings: {
        ...DEFAULT_BACKEND_SETTINGS,
        selectedBackend: 'bridge',
        bridgeUrl: 'http://127.0.0.1:8787?token=secret',
      },
      bridgeModelStatus: {
        modelId: 'stabilityai/sd-turbo',
        dependenciesReady: false,
        loaded: false,
        modelCached: false,
        device: 'cpu',
        cuda: false,
        cacheDir: 'C:/cache',
        installCommand: 'python -m pip install torch',
        message: 'Torch missing',
      },
      bridgeModelError: null,
      bridgeModelFolderStatus: null,
      bridgeModelFolderError: null,
      shelfSource: 'demo',
      assetCount: 3,
      health: [],
      queue: [],
      gallery: [],
    });

    expect(report).toContain('App version: 0.2.0');
    expect(report).toContain('Selected backend: bridge');
    expect(report).toContain('CUDA: false');
    expect(report).toContain('Approximate gallery size');
    expect(report).not.toContain('secret');
  });
});
