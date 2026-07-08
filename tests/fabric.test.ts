import { describe, it, expect } from 'vitest';
import { sanitizeAppSettings } from '../src/state/appSettings';

describe('appSettings graph3dEffects', () => {
  it('accepts the four valid effect levels', () => {
    for (const v of ['off', 'minimal', 'standard', 'rich'] as const) {
      expect(sanitizeAppSettings({ graph3dEffects: v }).graph3dEffects).toBe(v);
    }
  });

  it('drops invalid or missing values to undefined (older blobs still load)', () => {
    expect(sanitizeAppSettings({ graph3dEffects: 'ultra' as never }).graph3dEffects).toBeUndefined();
    expect(sanitizeAppSettings({}).graph3dEffects).toBeUndefined();
    expect(sanitizeAppSettings(undefined).graph3dEffects).toBeUndefined();
  });
});
