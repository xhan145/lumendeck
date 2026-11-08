import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readJson(path: string): any {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}

describe('Tauri sidecar configuration', () => {
  it('requires the packaged bridge in production builds', () => {
    const config = readJson('src-tauri/tauri.conf.json');
    expect(config.bundle.externalBin).toContain('binaries/lumendeck-bridge');
  });

  it('disables the packaged bridge only in the development override', () => {
    const config = readJson('src-tauri/tauri.dev.conf.json');
    expect(config.bundle.externalBin).toEqual([]);
  });

  it('routes the native dev command through the explicit override', () => {
    const pkg = readJson('package.json');
    expect(pkg.scripts['tauri:dev']).toBe('tauri dev --config src-tauri/tauri.dev.conf.json');
    expect(pkg.scripts.tauri).toBe('tauri');
  });
});
