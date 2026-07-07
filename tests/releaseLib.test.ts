import { describe, expect, it } from 'vitest';
import {
  buildAssetUrl,
  buildLatestJson,
  guardVersionTag,
  PLATFORM_KEY,
  REPO,
} from '../scripts/releaseLib.mjs';

describe('buildAssetUrl', () => {
  it('builds a GitHub release-asset URL with a v-prefixed tag', () => {
    expect(buildAssetUrl('0.19.0', 'LumenDeck_0.19.0_x64_en-US.msi.zip')).toBe(
      `https://github.com/${REPO}/releases/download/v0.19.0/LumenDeck_0.19.0_x64_en-US.msi.zip`,
    );
  });

  it('does not double-prefix an already v-prefixed version', () => {
    expect(buildAssetUrl('v0.19.0', 'a.msi')).toBe(
      `https://github.com/${REPO}/releases/download/v0.19.0/a.msi`,
    );
  });

  it('throws on missing version or file name', () => {
    // @ts-expect-error missing args
    expect(() => buildAssetUrl()).toThrow(/version/);
    expect(() => buildAssetUrl('0.19.0', '')).toThrow(/fileName/);
  });
});

describe('buildLatestJson', () => {
  const args = {
    version: '0.19.0',
    notes: 'First release',
    pubDate: '2026-07-07T00:00:00.000Z',
    sigContents: 'SIGNATURE-CONTENTS',
    assetUrl: 'https://github.com/xhan145/lumendeck/releases/download/v0.19.0/x.msi.zip',
  };

  it('produces the Tauri latest.json shape with signature + url', () => {
    const manifest = buildLatestJson(args);
    expect(manifest).toEqual({
      version: '0.19.0',
      notes: 'First release',
      pub_date: '2026-07-07T00:00:00.000Z',
      platforms: {
        'windows-x86_64': {
          signature: 'SIGNATURE-CONTENTS',
          url: 'https://github.com/xhan145/lumendeck/releases/download/v0.19.0/x.msi.zip',
        },
      },
    });
    expect(Object.keys(manifest.platforms)).toEqual([PLATFORM_KEY]);
  });

  it('defaults notes to empty and pub_date to an ISO timestamp', () => {
    const { notes, pubDate, ...rest } = args;
    void notes;
    void pubDate;
    const manifest = buildLatestJson(rest);
    expect(manifest.notes).toBe('');
    expect(() => new Date(manifest.pub_date).toISOString()).not.toThrow();
    expect(manifest.pub_date).toBe(new Date(manifest.pub_date).toISOString());
  });

  it('throws when version, sigContents, or assetUrl is missing', () => {
    expect(() => buildLatestJson({ ...args, version: '' })).toThrow(/version/);
    expect(() => buildLatestJson({ ...args, sigContents: '' })).toThrow(/sigContents/);
    expect(() => buildLatestJson({ ...args, assetUrl: '' })).toThrow(/assetUrl/);
  });
});

describe('guardVersionTag', () => {
  it('passes when the tag equals v + version', () => {
    expect(guardVersionTag('0.19.0', 'v0.19.0')).toBe(true);
  });

  it('throws on any mismatch', () => {
    expect(() => guardVersionTag('0.19.0', 'v0.18.0')).toThrow(/mismatch/i);
    expect(() => guardVersionTag('0.19.0', '0.19.0')).toThrow(); // missing v
    expect(() => guardVersionTag('0.19.0', 'v0.19.0-rc.1')).toThrow();
  });
});
