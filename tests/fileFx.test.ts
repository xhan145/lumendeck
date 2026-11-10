import { describe, expect, it } from 'vitest';
import { FILE_FX_PRESETS, makeFileFxGovernor, makeParticleCloud, stableFileHash } from '../src/core/shell/fileFx';
import { sanitizeAppSettings } from '../src/state/appSettings';

describe('Files constellation cinematic effects', () => {
  it('selects cinematic by default, but accepts explicit reduced settings', () => {
    expect(sanitizeAppSettings().fileFxMode).toBe('cinematic');
    expect(sanitizeAppSettings({ fileFxMode: 'off' }).fileFxMode).toBe('off');
    expect(sanitizeAppSettings({ fileFxMode: 'balanced' }).fileFxMode).toBe('balanced');
    expect(sanitizeAppSettings({ fileFxMode: 'bogus' as 'cinematic' }).fileFxMode).toBe('cinematic');
  });

  it('keeps particle and device-pixel budgets bounded and scaled by quality', () => {
    expect(FILE_FX_PRESETS.off.bloom).toBe(false);
    expect(FILE_FX_PRESETS.cinematic.bloom).toBe(true);
    expect(FILE_FX_PRESETS.cinematic.backgroundStars).toBeGreaterThan(FILE_FX_PRESETS.balanced.backgroundStars);
    expect(FILE_FX_PRESETS.cinematic.pixelRatioCap).toBeLessThanOrEqual(1.5);
    expect(FILE_FX_PRESETS.cinematic.ambientDust + FILE_FX_PRESETS.cinematic.backgroundStars).toBeLessThan(4000);
  });

  it('makes deterministic, finite, capped cloud buffers without Math.random', () => {
    const one = makeParticleCloud(12, 'distant', stableFileHash('MEKHANE'));
    const two = makeParticleCloud(12, 'distant', stableFileHash('MEKHANE'));
    expect(Array.from(one.positions)).toEqual(Array.from(two.positions));
    expect(Array.from(one.colors)).toEqual(Array.from(two.colors));
    expect(one.positions.length).toBe(36);
    expect(one.sizes.length).toBe(12);
    expect(one.positions.every(Number.isFinite)).toBe(true);
    expect(makeParticleCloud(9000, 'dust').sizes).toHaveLength(6000);
    expect(makeParticleCloud(-1, 'dust').sizes).toHaveLength(0);
  });

  it('drops cosmetics only after sustained slow frames, with no flapping', () => {
    const governor = makeFileFxGovernor();
    for (let n = 0; n < 55; n++) expect(governor.feed(42)).toBe(false);
    expect(governor.degraded()).toBe(false);
    let changed = false;
    for (let n = 0; n < 10; n++) changed = governor.feed(42) || changed;
    expect(changed).toBe(true);
    expect(governor.degraded()).toBe(true);
    expect(governor.feed(4)).toBe(false);
  });
});
