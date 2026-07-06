import { describe, expect, it } from 'vitest';
import { fallbackReasonFor, isFallbackRender, renderBackendLabel, renderModeLabel } from '../src/core/renderHonesty';

describe('render honesty helpers', () => {
  it('detects explicit fallback metadata', () => {
    const item = {
      fallback: true,
      fallbackReason: 'CUDA unavailable',
      actualBackend: 'procedural',
      selectedBackend: 'bridge',
      renderMode: 'fallback',
    };

    expect(isFallbackRender(item)).toBe(true);
    expect(fallbackReasonFor(item)).toBe('CUDA unavailable');
    expect(renderBackendLabel(item)).toBe('Fallback: procedural');
    expect(renderModeLabel(item)).toBe('Fallback');
  });

  it('detects old manifest warning fallback metadata', () => {
    const item = {
      manifest: {
        turboForge: {
          backendId: 'diffusers',
          warnings: [{ code: 'backend-fallback', message: 'Bridge used a placeholder.' }],
        },
      },
    };

    expect(isFallbackRender(item)).toBe(true);
    expect(fallbackReasonFor(item)).toBe('Bridge used a placeholder.');
  });

  it('labels clean real renders without fallback language', () => {
    const item = {
      manifest: {
        render: {
          selectedBackend: 'bridge',
          actualBackend: 'bridge',
          mode: 'real' as const,
          fallback: false,
        },
      },
    };

    expect(isFallbackRender(item)).toBe(false);
    expect(renderBackendLabel(item)).toBe('bridge');
    expect(renderModeLabel(item)).toBe('Real model');
  });
});
