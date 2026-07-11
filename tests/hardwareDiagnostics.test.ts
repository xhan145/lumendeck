import { describe, expect, it } from 'vitest';
import { formatDiagnosticsReport, type DiagnosticsReportInput } from '../src/core/diagnostics';
import { DEFAULT_BACKEND_SETTINGS } from '../src/turboForge/backends/backendSettings';

const SECRET_PROMPT = 'MY_SECRET_PROMPT_TEXT_1234';

function input(overrides: Partial<DiagnosticsReportInput> = {}): DiagnosticsReportInput {
  return {
    appVersion: '0.33.0',
    now: new Date('2026-07-11T00:00:00Z'),
    selectedBackend: 'bridge',
    bridgeOnline: true,
    backendSettings: { ...DEFAULT_BACKEND_SETTINGS },
    bridgeModelStatus: null,
    bridgeModelError: null,
    bridgeModelFolderStatus: null,
    bridgeModelFolderError: null,
    shelfSource: 'bridge',
    assetCount: 1,
    health: [],
    // a queue job whose label embeds the user's prompt — must NOT leak.
    queue: [{ id: 'j1', status: 'done', progress: 1, label: `Image: ${SECRET_PROMPT}` } as never],
    gallery: [],
    hardware: {
      selectedProfile: 'auto',
      effectiveProfile: 'gtx_1650_4gb',
      gpuName: 'NVIDIA GeForce GTX 1650',
      totalVramMb: 4096,
      freeVramMb: 3600,
      backend: 'diffusers',
      cuda: true,
      computeCapability: '7.5',
      precision: 'fp16',
      modelCpuOffload: true,
      attentionSlicing: true,
      vaeSlicing: true,
      vaeTiling: true,
      resolutionLimit: 768,
      requestedResolution: '512x512',
      requestedBatch: 1,
      activeModelFamily: 'SD1.5',
      oomCategory: 'none',
      fallbackOccurred: false,
    },
    ...overrides,
  };
}

describe('hardware profile diagnostics', () => {
  it('renders a hardware profile section with the key fields (diagnostics requirement)', () => {
    const report = formatDiagnosticsReport(input());
    expect(report).toContain('[Hardware profile]');
    expect(report).toContain('Selected profile: auto');
    expect(report).toContain('Effective profile: gtx_1650_4gb');
    expect(report).toContain('NVIDIA GeForce GTX 1650');
    expect(report).toContain('Total VRAM: 4096');
    expect(report).toContain('Precision: fp16');
    expect(report).toContain('Model CPU offload: true');
    expect(report).toContain('Requested resolution: 512x512');
    expect(report).toContain('OOM category: none');
  });

  it('never includes user prompt text or generated image content (test 22)', () => {
    const report = formatDiagnosticsReport(input());
    expect(report).not.toContain(SECRET_PROMPT);
    expect(report).not.toContain('data:image');
    expect(report).not.toContain('base64');
  });

  it('degrades gracefully when hardware info is absent (startup without a GPU, test 24)', () => {
    const report = formatDiagnosticsReport(input({ hardware: undefined }));
    // Section still renders with unknowns rather than throwing.
    expect(report).toContain('[Hardware profile]');
    expect(report).toContain('Effective profile: unknown');
  });
});
