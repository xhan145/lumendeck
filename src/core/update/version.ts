/**
 * Pure semantic-version helpers for the auto-updater.
 *
 * No `fetch`, no Tauri imports, no side effects — everything here is a pure
 * function so it can be unit-tested in the Node/vitest environment and reused by
 * both the in-app Updates card and the release tooling.
 *
 * Versions may carry an optional leading `v` (`v0.19.0`) and an optional
 * pre-release tag (`0.19.0-rc.1`). Anything that does not parse is treated as
 * "unknown" and never spuriously reported as newer (see {@link isNewer}).
 */

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, e.g. `['rc', '1']`. Empty for releases. */
  prerelease: string[];
}

// Core `X.Y.Z` with an optional leading `v` and an optional `-prerelease` tag.
// Build metadata (`+meta`) is ignored per semver (it does not affect ordering).
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version string into its parts, or `null` if it is malformed. */
export function parseSemver(input: unknown): ParsedSemver | null {
  if (typeof input !== 'string') return null;
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  return { major, minor, patch, prerelease };
}

function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) {
    const na = Number(a);
    const nb = Number(b);
    return na > nb ? 1 : na < nb ? -1 : 0;
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (numericA) return -1;
  if (numericB) return 1;
  return a > b ? 1 : a < b ? -1 : 0;
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A release (no pre-release tag) outranks a pre-release of the same core.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifier(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  if (a.length > b.length) return 1;
  if (a.length < b.length) return -1;
  return 0;
}

/**
 * Compare two semver strings.
 * @returns `1` if `a > b`, `-1` if `a < b`, `0` if equal.
 *
 * Malformed input is ordered below any valid version (and two malformed inputs
 * compare equal), so callers never crash on garbage and never treat an
 * unparseable "latest" as an upgrade.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Is `latest` strictly newer than `current`?
 * Returns `false` for equal versions and for any malformed `latest`.
 */
export function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

export interface UpdaterPlatform {
  signature: string;
  url: string;
}

export interface UpdaterManifest {
  version: string;
  notes: string;
  platforms: Record<string, UpdaterPlatform>;
}

/**
 * Validate and normalize a Tauri `latest.json` payload.
 *
 * @throws {Error} when the shape is invalid (not an object, missing/blank
 * version, missing/empty platforms, or a platform entry lacking `signature`/`url`).
 */
export function parseUpdaterManifest(json: unknown): UpdaterManifest {
  if (!json || typeof json !== 'object') {
    throw new Error('updater manifest: expected an object');
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    throw new Error('updater manifest: missing or blank "version"');
  }
  if (!obj.platforms || typeof obj.platforms !== 'object') {
    throw new Error('updater manifest: missing "platforms" object');
  }
  const platforms: Record<string, UpdaterPlatform> = {};
  for (const [key, value] of Object.entries(obj.platforms as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      throw new Error(`updater manifest: platform "${key}" is not an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.signature !== 'string' || typeof entry.url !== 'string') {
      throw new Error(`updater manifest: platform "${key}" missing "signature"/"url"`);
    }
    platforms[key] = { signature: entry.signature, url: entry.url };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error('updater manifest: "platforms" is empty');
  }
  const notes = typeof obj.notes === 'string' ? obj.notes : '';
  return { version: obj.version, notes, platforms };
}

/**
 * The Tauri updater platform key for this app.
 * LumenDeck ships a Windows x64 MSI only, so this is a constant.
 */
export function platformKey(): string {
  return 'windows-x86_64';
}
