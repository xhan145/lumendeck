import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BACKEND_SETTINGS,
  sanitizeBackendSettings,
} from '../src/turboForge/backends/backendSettings';

describe('bridgeRenderer setting', () => {
  it('defaults to auto', () => {
    expect(DEFAULT_BACKEND_SETTINGS.bridgeRenderer).toBe('auto');
  });

  it('rejects invalid values back to auto', () => {
    const s = sanitizeBackendSettings({ ...DEFAULT_BACKEND_SETTINGS, bridgeRenderer: 'bogus' as never });
    expect(s.bridgeRenderer).toBe('auto');
  });

  it('preserves valid values', () => {
    expect(sanitizeBackendSettings({ bridgeRenderer: 'diffusers' }).bridgeRenderer).toBe('diffusers');
    expect(sanitizeBackendSettings({ bridgeRenderer: 'procedural' }).bridgeRenderer).toBe('procedural');
  });
});
