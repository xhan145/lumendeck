import { describe, expect, it } from 'vitest';
import { buildFileConstellation } from '../src/components/constellation/files';
import { indexConstellation } from '../src/components/constellation/selection';

describe('read-only file constellation', () => {
  it('groups selected folder files and preserves their names', () => {
    const root = buildFileConstellation([
      { relativePath: 'MEKHANE/assets/cover.png', size: 1024 },
      { relativePath: 'MEKHANE/assets/master.wav', size: 2048 },
    ], 'MEKHANE');
    const assets = root.children?.find(n => n.label === 'assets');
    expect(assets?.children?.map(n => n.label)).toEqual(['cover.png', 'master.wav']);
    expect(indexConstellation(root).size).toBe(4);
  });
  it('rejects traversal entries and caps the scene to 200 files', () => {
    const entries = [{ relativePath: 'root/../bad.txt', size: 1 }, ...Array.from({ length: 250 }, (_, i) => ({ relativePath: `root/file-${i}.txt`, size: i }))];
    const root = buildFileConstellation(entries);
    expect(root.children?.some(n => n.label === 'bad.txt')).toBe(false);
    expect(root.children?.length).toBe(200);
  });
  it('collapses deep paths instead of creating unbounded nested planets', () => {
    const root = buildFileConstellation([{ relativePath: 'root/a/b/c/d/e.txt', size: 12 }]);
    const index = indexConstellation(root);
    expect([...index.keys()].some(k => k.startsWith('file-depth:'))).toBe(true);
  });
});
