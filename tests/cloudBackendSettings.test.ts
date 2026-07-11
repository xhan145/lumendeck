import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKEND_SETTINGS,
  sanitizeBackendSettings,
  settingsBackendToTurboBackend,
} from '../src/turboForge/backends/backendSettings';

describe('cloud backend settings', () => {
  it('defaults cloudProvider to openai and cloudModel to empty', () => {
    const s = sanitizeBackendSettings(undefined);
    expect(s.cloudProvider).toBe('openai');
    expect(s.cloudModel).toBe('');
    expect(DEFAULT_BACKEND_SETTINGS.cloudProvider).toBe('openai');
  });

  it('accepts cloud as a backend and maps it to future-cloud for turbo', () => {
    const s = sanitizeBackendSettings({ selectedBackend: 'cloud' });
    expect(s.selectedBackend).toBe('cloud');
    expect(settingsBackendToTurboBackend('cloud')).toBe('future-cloud');
  });

  it('preserves saved provider/model and trims whitespace', () => {
    const s = sanitizeBackendSettings({ cloudProvider: ' fal ', cloudModel: ' fal-ai/flux/dev ' });
    expect(s.cloudProvider).toBe('fal');
    expect(s.cloudModel).toBe('fal-ai/flux/dev');
  });
});
