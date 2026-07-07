// Pure, dependency-free helpers for building a Tauri updater release.
//
// These functions do NO I/O and NO shelling-out — that lives in release.mjs.
// Keeping them pure means they are unit-tested directly (tests/releaseLib.test.ts)
// and reused without side effects.

/** GitHub `owner/repo` this project publishes to. */
export const REPO = 'xhan145/lumendeck';

/** The single Tauri updater platform key LumenDeck ships (Windows x64 MSI). */
export const PLATFORM_KEY = 'windows-x86_64';

/**
 * Build the GitHub release-asset download URL for a given version + file name.
 * @param {string} version - e.g. `0.19.0` or `v0.19.0` (leading `v` optional).
 * @param {string} fileName - the uploaded asset's file name.
 * @returns {string} `https://github.com/<repo>/releases/download/vX.Y.Z/<file>`
 */
export function buildAssetUrl(version, fileName) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('buildAssetUrl: version is required');
  }
  if (typeof fileName !== 'string' || fileName.trim() === '') {
    throw new Error('buildAssetUrl: fileName is required');
  }
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${REPO}/releases/download/${tag}/${fileName}`;
}

/**
 * Assemble a Tauri `latest.json` manifest object.
 * @param {object} args
 * @param {string} args.version - release version, no leading `v` (matches package.json).
 * @param {string} [args.notes] - release notes / changelog body.
 * @param {string} [args.pubDate] - ISO 8601 publish date (defaults to now).
 * @param {string} args.sigContents - the contents of the `.sig` file for the artifact.
 * @param {string} args.assetUrl - download URL of the `.msi.zip` (see buildAssetUrl).
 * @param {string} [args.platform] - platform key (defaults to `windows-x86_64`).
 * @returns {{version:string, notes:string, pub_date:string, platforms:Record<string,{signature:string,url:string}>}}
 */
export function buildLatestJson({ version, notes, pubDate, sigContents, assetUrl, platform } = {}) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('buildLatestJson: version is required');
  }
  if (typeof sigContents !== 'string' || sigContents.trim() === '') {
    throw new Error('buildLatestJson: sigContents is required');
  }
  if (typeof assetUrl !== 'string' || assetUrl.trim() === '') {
    throw new Error('buildLatestJson: assetUrl is required');
  }
  const key = platform || PLATFORM_KEY;
  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [key]: {
        signature: sigContents,
        url: assetUrl,
      },
    },
  };
}

/**
 * Guard that a git tag matches the package version exactly (`tag === 'v'+version`).
 * @param {string} pkgVersion - the version from package.json, e.g. `0.19.0`.
 * @param {string} tag - the proposed git tag, e.g. `v0.19.0`.
 * @returns {true} when they match.
 * @throws {Error} when they do not match.
 */
export function guardVersionTag(pkgVersion, tag) {
  const expected = `v${pkgVersion}`;
  if (tag !== expected) {
    throw new Error(
      `Version/tag mismatch: package version ${pkgVersion} expects tag "${expected}", got "${tag}"`,
    );
  }
  return true;
}
