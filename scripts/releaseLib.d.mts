// Type declarations for the pure ESM release helpers (scripts/releaseLib.mjs).
// Lets `tsc --noEmit` type-check tests/releaseLib.test.ts which imports the .mjs.

export const REPO: string;
export const PLATFORM_KEY: string;

export function buildAssetUrl(version: string, fileName: string): string;

export interface LatestJsonArgs {
  version: string;
  notes?: string;
  pubDate?: string;
  sigContents: string;
  assetUrl: string;
  platform?: string;
}

export interface LatestJsonManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

export function buildLatestJson(args: LatestJsonArgs): LatestJsonManifest;

export function guardVersionTag(pkgVersion: string, tag: string): true;
