import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, sanitizeAppSettings } from '../src/state/appSettings';

describe('hardware profile settings persistence', () => {
  it('defaults hardwareProfile to auto so missing config preserves current behavior (test 2)', () => {
    expect(DEFAULT_APP_SETTINGS.hardwareProfile).toBe('auto');
    expect(sanitizeAppSettings(undefined).hardwareProfile).toBe('auto');
    expect(sanitizeAppSettings({}).hardwareProfile).toBe('auto');
  });

  it('parses a valid gtx_1650_4gb config (test 1)', () => {
    expect(sanitizeAppSettings({ hardwareProfile: 'gtx_1650_4gb' }).hardwareProfile).toBe('gtx_1650_4gb');
  });

  it('accepts every known profile id', () => {
    for (const id of ['auto', 'gtx_1650_4gb', 'balanced', 'high_performance', 'cpu'] as const) {
      expect(sanitizeAppSettings({ hardwareProfile: id }).hardwareProfile).toBe(id);
    }
  });

  it('falls back to auto for unknown or malformed values (test 3)', () => {
    // @ts-expect-error intentionally invalid
    expect(sanitizeAppSettings({ hardwareProfile: 'rtx_9999' }).hardwareProfile).toBe('auto');
    // @ts-expect-error intentionally invalid
    expect(sanitizeAppSettings({ hardwareProfile: 42 }).hardwareProfile).toBe('auto');
    // @ts-expect-error intentionally invalid
    expect(sanitizeAppSettings({ hardwareProfile: null }).hardwareProfile).toBe('auto');
  });

  it('does not disturb other existing settings when hardwareProfile is added (test 23)', () => {
    const s = sanitizeAppSettings({ hardwareProfile: 'gtx_1650_4gb', vramSafetyMode: 'strict', maxConcurrentJobs: 3 });
    expect(s.vramSafetyMode).toBe('strict');
    expect(s.maxConcurrentJobs).toBe(3);
    expect(s.localOnlyMode).toBe(true);
    expect(s.telemetryDisabled).toBe(true);
  });
});
