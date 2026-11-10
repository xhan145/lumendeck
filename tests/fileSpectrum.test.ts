import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FileEntry } from '../src/bridge/files';
import type { FileStar } from '../src/core/shell/fileMap';
import {
  spectrumSignal, spectrumStarColor, spectrumCssGradient,
} from '../src/core/shell/fileSpectrum';
import { makeStarGradientSurface } from '../src/components/shell/fileSpectrumGeometry';
import { sanitizeAppSettings } from '../src/state/appSettings';

const file: FileEntry = {
  name: 'Orbit-mix.wav', path: 'C:\\Projects\\Orbit-mix.wav',
  kind: 'audio', extension: 'wav', isDirectory: false, isSymlink: false,
  isReadOnly: false, sizeBytes: 400, modifiedMs: 500,
};
const star: FileStar = { entry: file, x: 1.5, y: -0.4, z: 2.3,
  color: '#d0a6d8', group: 'audio' };
const bounds = { firstMs: 0, lastMs: 1000, datedCount: 3, distinctDates: true };

describe('sixth-dimensional Spectrum (S)', () => {
  it('sanitizes persisted Spectrum mode without changing other settings', () => {
    expect(sanitizeAppSettings().fileSpectrumMode).toBe('drift');
    expect(sanitizeAppSettings({ fileSpectrumMode: 'off' }).fileSpectrumMode).toBe('off');
    expect(sanitizeAppSettings({ fileSpectrumMode: 'gradient' }).fileSpectrumMode).toBe('gradient');
    expect(sanitizeAppSettings({ fileSpectrumMode: 'nonsense' as 'drift' }).fileSpectrumMode).toBe('drift');
    expect(sanitizeAppSettings({ fileSpectrumMode: 'off', fileFxMode: 'balanced' }).fileFxMode)
      .toBe('balanced');
  });

  it('only uses observed modification timestamps to shift the spectral signal', () => {
    const close = spectrumSignal(star, bounds, 0.5, 0);
    const distant = spectrumSignal(star, bounds, 0, 0);
    expect(close.temporal).toBe(1);
    expect(distant.temporal).toBe(0);
    expect(close.energy).toBeGreaterThan(distant.energy);
    expect(spectrumStarColor(star, close, 'gradient', false, false, 0, false))
      .not.toBe(spectrumStarColor(star, distant, 'gradient', false, false, 0, false));
    const missing = spectrumSignal({ ...star, entry: { ...file, modifiedMs: null } }, bounds, 0.5, 0);
    expect(missing.temporal).toBeNull();
    expect(missing.energy).toBe(0);
    expect(spectrumSignal(star, null, 1, 0).temporal).toBeNull();
  });

  it('clamps invalid context confidence to a bounded visual contribution', () => {
    expect(spectrumSignal(star, null, 0.5, Number.NaN).contextual).toBe(0);
    expect(spectrumSignal(star, null, 0.5, 600).contextual).toBe(1);
    expect(spectrumSignal(star, null, 0.5, -10).contextual).toBe(0);
    expect(spectrumSignal(star, null, 0.5, 100).energy).toBe(0.43);
  });

  it('restores unchanged base colors when Off and marks selection', () => {
    const signal = spectrumSignal(star, bounds, 0.5, 80);
    expect(spectrumStarColor(star, signal, 'off', false, false, 30, true)).toBe(star.color);
    expect(spectrumStarColor(star, signal, 'off', true, false, 30, true)).toBe('#ffffff');
    expect(spectrumStarColor(star, signal, 'gradient', false, false, 0, false))
      .toMatch(/^#[0-9a-f]{6}$/);
    expect(spectrumCssGradient(star.color, signal)).toMatch(/^linear-gradient\(135deg, #[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  });

  it('only drifts when motion is permitted; paused gradients remain deterministic', () => {
    const signal = spectrumSignal(star, bounds, 0.5, 35);
    const a = spectrumStarColor(star, signal, 'drift', false, false, 0, false);
    const b = spectrumStarColor(star, signal, 'drift', false, false, 50, false);
    expect(a).toBe(b);
    expect(spectrumStarColor(star, signal, 'gradient', false, false, 0, true))
      .toBe(spectrumStarColor(star, signal, 'gradient', false, false, 50, true));
    expect(spectrumStarColor(star, signal, 'drift', false, false, 0, true))
      .not.toBe(spectrumStarColor(star, signal, 'drift', false, false, 50, true));
  });

  it('keeps gradient geometry GPU-instanced with a reversible Off mode', () => {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const gradient = makeStarGradientSurface(geometry);
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(attribute.count).toBe(geometry.getAttribute('position').count);
    const first = [attribute.getX(0), attribute.getY(0), attribute.getZ(0)];
    expect(first.every(Number.isFinite)).toBe(true);
    const vertices = geometry.getAttribute('position') as THREE.BufferAttribute;
    let darkest = 0;
    let brightest = 0;
    for (let i = 1; i < vertices.count; i++) {
      if (vertices.getY(i) < vertices.getY(darkest)) darkest = i;
      if (vertices.getY(i) > vertices.getY(brightest)) brightest = i;
    }
    expect(attribute.getX(brightest)).toBeGreaterThan(attribute.getX(darkest));
    expect(attribute.getY(brightest)).toBeGreaterThan(attribute.getY(darkest));
    gradient.setActive(false);
    for (let i = 0; i < attribute.count; i++) {
      expect([attribute.getX(i), attribute.getY(i), attribute.getZ(i)]).toEqual([1, 1, 1]);
    }
    gradient.setActive(true);
    expect([attribute.getX(0), attribute.getY(0), attribute.getZ(0)]).toEqual(first);
    geometry.dispose();
  });
});
