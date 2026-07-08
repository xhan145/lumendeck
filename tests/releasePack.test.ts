import { describe, expect, it } from 'vitest';
import { crc32, dataUrlToBytes, textBytes, zipSync } from '../src/core/creative/zip';
import { buildReleasePack, packExportRecord } from '../src/core/creative/releasePack';
import { createBrain } from '../src/core/creative/brain';
import type { AnalysisContext, RenderInfo } from '../src/core/creative/context';
import type { ProjectBrain } from '../src/core/creative/types';

const NOW = new Date('2026-07-07T12:00:00.000Z');

function ctxOf(renders: RenderInfo[]): AnalysisContext {
  return { renders, knownModelIds: new Set() };
}

describe('zip writer', () => {
  it('computes the known CRC-32 of "123456789"', () => {
    // Canonical CRC-32 check value.
    expect(crc32(textBytes('123456789')) >>> 0).toBe(0xcbf43926);
  });

  it('produces a ZIP starting with the local-file-header signature', () => {
    const zip = zipSync([{ name: 'a.txt', data: textBytes('hello') }]);
    // 'PK\x03\x04'
    expect([zip[0], zip[1], zip[2], zip[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // ends with the End-Of-Central-Directory signature 'PK\x05\x06'
    const eocd = zip.subarray(zip.length - 22, zip.length - 18);
    expect([eocd[0], eocd[1], eocd[2], eocd[3]]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('records the correct file count in the central directory', () => {
    const zip = zipSync([
      { name: 'a.txt', data: textBytes('a') },
      { name: 'b/c.txt', data: textBytes('cc') },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // total entries field lives at EOCD+10 (little-endian u16)
    const eocdStart = zip.length - 22;
    expect(view.getUint16(eocdStart + 10, true)).toBe(2);
  });

  it('is byte-deterministic for identical input', () => {
    const a = zipSync([{ name: 'x', data: textBytes('same') }]);
    const b = zipSync([{ name: 'x', data: textBytes('same') }]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('decodes base64 and percent-encoded data URLs', () => {
    const b64 = dataUrlToBytes('data:text/plain;base64,aGk='); // "hi"
    expect(Array.from(b64)).toEqual([0x68, 0x69]);
    const utf = dataUrlToBytes('data:image/svg+xml;utf8,%3Csvg%3E');
    expect(new TextDecoder().decode(utf)).toBe('<svg>');
  });
});

describe('release pack builder', () => {
  const readyBrain = (): ProjectBrain => ({
    ...createBrain('Aurora Type', 'brand', NOW),
    identity: { logline: 'A glowing typeface.', audience: 'designers', promise: 'glow' },
    style: { styleTags: ['luminous'], palette: ['#34d6f4'], mood: 'calm' },
    assets: [{ id: 'as1', label: 'Logo', kind: 'logo', galleryId: 'g_logo', status: 'ok', addedAt: NOW.toISOString() }],
    renders: ['g_logo', 'g_16', 'g_1', 'g_9'],
  });

  const resolver = (_id: string) => ({ dataUrl: 'data:image/svg+xml;utf8,%3Csvg%3E', extension: 'svg' });

  it('assembles a structured folder with copy, checklist, metadata', () => {
    const b = readyBrain();
    const ctx = ctxOf([
      { id: 'g_logo', createdAt: NOW.toISOString(), aspect: '1:1', labeled: true, signature: 's1', prompt: 'logo', linkedToProject: true },
      { id: 'g_16', createdAt: NOW.toISOString(), aspect: '16:9', labeled: true, signature: 's2', prompt: 'hero', linkedToProject: true },
      { id: 'g_1', createdAt: NOW.toISOString(), aspect: '1:1', labeled: true, signature: 's3', prompt: 'sq', linkedToProject: true },
      { id: 'g_9', createdAt: NOW.toISOString(), aspect: '9:16', labeled: true, signature: 's4', prompt: 'vert', linkedToProject: true },
    ]);
    const pack = buildReleasePack(b, ctx, resolver, NOW);
    expect(pack.folderName).toBe('aurora-type-release-pack');
    const paths = pack.entries.map((e) => e.name.replace(`${pack.folderName}/`, ''));
    expect(paths).toContain('README.md');
    expect(paths).toContain('project.metadata.json');
    expect(paths).toContain('LAUNCH-CHECKLIST.md');
    expect(paths).toContain('copy/short-description.txt');
    // Every promo aspect + logo resolved -> present slots.
    expect(pack.summary.present).toBeGreaterThan(0);
    expect(pack.summary.total).toBeGreaterThanOrEqual(pack.summary.present);
    expect(pack.zip.length).toBeGreaterThan(22);
  });

  it('emits TODO placeholders for missing pieces', () => {
    const b = createBrain('Bare', 'app', NOW); // no logo, no promos
    const pack = buildReleasePack(b, ctxOf([]), () => null, NOW);
    const todo = pack.slots.filter((s) => !s.present);
    expect(todo.length).toBeGreaterThan(0);
    // A logo TODO placeholder file exists.
    expect(pack.entries.some((e) => e.name.includes('logo/logo.TODO.txt'))).toBe(true);
  });

  it('packExportRecord captures slot counts + size', () => {
    const b = createBrain('Bare', 'app', NOW);
    const pack = buildReleasePack(b, ctxOf([]), () => null, NOW);
    const rec = packExportRecord(pack, NOW);
    expect(rec.kind).toBe('release-pack');
    expect(rec.fileName).toBe('bare-release-pack.zip');
    expect(rec.itemCount).toBe(pack.summary.total);
    expect(rec.bytes).toBe(pack.zip.length);
  });
});
