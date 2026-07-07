import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isNewer,
  parseSemver,
  parseUpdaterManifest,
  platformKey,
} from '../src/core/update/version';

describe('parseSemver', () => {
  it('parses core versions with and without a leading v', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver('v0.19.0')).toEqual({ major: 0, minor: 19, patch: 0, prerelease: [] });
  });

  it('parses pre-release tags and ignores build metadata', () => {
    expect(parseSemver('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1']);
    expect(parseSemver('1.0.0+build.5')?.prerelease).toEqual([]);
  });

  it('returns null for malformed input', () => {
    const bad: unknown[] = ['', 'x', '1', '1.2', '1.2.x', 'not-a-version', null, undefined, 42, {}];
    for (const value of bad) {
      expect(parseSemver(value)).toBeNull();
    }
  });
});

describe('compareSemver', () => {
  it('orders by major, minor, patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.19.0', '0.18.0')).toBe(1);
    expect(compareSemver('0.18.0', '0.19.0')).toBe(-1);
    expect(compareSemver('1.2.10', '1.2.9')).toBe(1); // numeric, not lexical
  });

  it('treats equal versions (with/without v) as equal', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a release above its pre-release', () => {
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });

  it('compares pre-release identifiers per semver rules', () => {
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.1.1')).toBe(-1); // fewer fields < more
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1); // numeric < alphanumeric
  });

  it('orders malformed input below any valid version and equal to each other', () => {
    expect(compareSemver('garbage', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', 'garbage')).toBe(1);
    expect(compareSemver('garbage', 'nonsense')).toBe(0);
  });
});

describe('isNewer', () => {
  it('is true only when latest is strictly greater', () => {
    expect(isNewer('0.19.0', '0.18.0')).toBe(true);
    expect(isNewer('0.18.0', '0.18.0')).toBe(false);
    expect(isNewer('0.17.0', '0.18.0')).toBe(false);
  });

  it('never reports a malformed latest as newer', () => {
    expect(isNewer('garbage', '0.18.0')).toBe(false);
  });
});

describe('platformKey', () => {
  it('is the Windows x64 Tauri key', () => {
    expect(platformKey()).toBe('windows-x86_64');
  });
});

describe('parseUpdaterManifest', () => {
  const valid = {
    version: '0.19.0',
    notes: 'First release',
    pub_date: '2026-07-07T00:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ...',
        url: 'https://github.com/xhan145/lumendeck/releases/download/v0.19.0/LumenDeck_0.19.0_x64_en-US.msi.zip',
      },
    },
  };

  it('accepts a valid manifest and returns version/notes/platforms', () => {
    const parsed = parseUpdaterManifest(valid);
    expect(parsed.version).toBe('0.19.0');
    expect(parsed.notes).toBe('First release');
    expect(parsed.platforms['windows-x86_64'].url).toContain('.msi.zip');
    expect(parsed.platforms['windows-x86_64'].signature).toBeTruthy();
  });

  it('defaults notes to empty string when absent', () => {
    const { notes, ...rest } = valid;
    void notes;
    expect(parseUpdaterManifest(rest).notes).toBe('');
  });

  it('throws when platforms is empty (missing platform)', () => {
    expect(() => parseUpdaterManifest({ version: '0.19.0', platforms: {} })).toThrow(/platforms/);
  });

  it('throws when a platform entry is missing signature/url', () => {
    expect(() =>
      parseUpdaterManifest({
        version: '0.19.0',
        platforms: { 'windows-x86_64': { url: 'https://example.com/x.zip' } },
      }),
    ).toThrow(/signature/);
  });

  it('throws on bad shape (non-object, missing version, no platforms)', () => {
    expect(() => parseUpdaterManifest(null)).toThrow();
    expect(() => parseUpdaterManifest('nope')).toThrow();
    expect(() => parseUpdaterManifest({ platforms: valid.platforms })).toThrow(/version/);
    expect(() => parseUpdaterManifest({ version: '' })).toThrow(/version/);
    expect(() => parseUpdaterManifest({ version: '0.19.0' })).toThrow(/platforms/);
  });
});
