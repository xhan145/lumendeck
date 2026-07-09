import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/state/storeConstants';

/**
 * Version drift guard.
 *
 * The app version lives in several files that must be bumped together:
 *   - package.json                (npm + the Vite-injected APP_VERSION)
 *   - src-tauri/tauri.conf.json    (the compiled desktop app version)
 *   - src-tauri/Cargo.toml         (the Rust crate version)
 *
 * A missed bump is exactly how a released 0.20.0 build shipped displaying
 * "v0.19.1" (APP_VERSION was a 5th hardcoded copy). These assertions fail CI/the
 * pre-release test run if any source disagrees, and confirm the Vite `define`
 * wiring actually replaces __APP_VERSION__ (APP_VERSION === package.json version).
 */
function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf-8');
}

const pkgVersion = JSON.parse(read('../package.json')).version as string;
const tauriVersion = JSON.parse(read('../src-tauri/tauri.conf.json')).version as string;
const cargoVersion = (read('../src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m) ?? [])[1];

describe('version sync', () => {
  it('package.json has a valid semver-ish version', () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('tauri.conf.json version matches package.json', () => {
    expect(tauriVersion).toBe(pkgVersion);
  });

  it('Cargo.toml version matches package.json', () => {
    expect(cargoVersion).toBe(pkgVersion);
  });

  it('APP_VERSION (Vite-injected) matches package.json — the display never drifts', () => {
    expect(APP_VERSION).toBe(pkgVersion);
  });
});
