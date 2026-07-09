import { describe, expect, it } from 'vitest';
import { showcaseInputFromRenders, utf8ToBase64, type RenderSource } from '../src/core/share/showcaseInput';
import { buildShowcaseHtml } from '../src/core/share/showcase';
import { parseLumenFile } from '../src/core/lumenFile';
import type { ExportManifest } from '../src/core/manifest';
import type { Workflow } from '../src/core/types';

const graph: Workflow = {
  id: 'w1',
  name: 'G',
  version: 3,
  schemaVersion: 1,
  nodes: [{ id: 'prompt', kind: 'prompt', x: 10, y: 10, params: {} }],
  edges: [],
};

function mkManifest(over: Partial<ExportManifest> = {}): ExportManifest {
  return {
    app: 'LumenDeck',
    appVersion: '0.20.1',
    createdAt: '2026-07-08T00:00:00.000Z',
    prompt: 'a cat',
    negativePrompt: 'blurry',
    resolvedPrompt: 'a cat',
    wildcards: [],
    seed: 42,
    sampler: { name: 'euler', steps: 4, cfg: 1 },
    canvas: { width: 512, height: 512 },
    media: { type: 'image', format: 'png', frameCount: 1, fps: 0 },
    model: { id: 'm', name: 'sd-turbo', family: 'SD1.5', hash: 'abc' },
    loras: [{ id: 'l', name: 'crisp', weight: 0.8, hash: 'h' }],
    controlNets: [],
    graphVersion: 3,
    graph,
    ...over,
  } as ExportManifest;
}

const source = (over: Partial<RenderSource> = {}): RenderSource => ({
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  mediaType: 'image',
  manifest: mkManifest(),
  ...over,
});

describe('showcaseInputFromRenders', () => {
  it('maps manifest facts into provenance', () => {
    const input = showcaseInputFromRenders('My Cat', [source()], new Date('2026-07-08T00:00:00Z'));
    expect(input.provenance.prompt).toBe('a cat');
    expect(input.provenance.model).toBe('sd-turbo');
    expect(input.provenance.seed).toBe(42);
    const labels = (input.provenance.params ?? []).map((p) => p.label);
    expect(labels).toContain('Sampler');
    expect(labels).toContain('Canvas');
    expect(labels).toContain('LoRAs');
  });

  it('embeds a remixable .lumen that round-trips to the source workflow', () => {
    const input = showcaseInputFromRenders('My Cat', [source()], new Date('2026-07-08T00:00:00Z'));
    expect(input.lumen).toBeTruthy();
    const json = Buffer.from(input.lumen!.base64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    expect(parsed.app).toBe('LumenDeck');
    expect(parsed.workflow.id).toBe('w1');
    expect(parsed.workflow.nodes).toHaveLength(1);
    expect(input.constellationSvg).toContain('<svg');
  });

  it('is provenance-only (no lumen/constellation) when the graph is empty', () => {
    const emptyGraph = { ...graph, nodes: [], edges: [] };
    const input = showcaseInputFromRenders('X', [source({ manifest: mkManifest({ graph: emptyGraph }) })], new Date());
    expect(input.lumen).toBeUndefined();
    expect(input.constellationSvg).toBeUndefined();
  });

  it('carries every source as an item, including mimeType', () => {
    const input = showcaseInputFromRenders(
      'Multi',
      [source(), source({ caption: 'two', mediaType: 'video', mimeType: 'image/gif' })],
      new Date(),
    );
    expect(input.items).toHaveLength(2);
    expect(input.items[1].caption).toBe('two');
    expect(input.items[1].mimeType).toBe('image/gif');
  });

  it('embeds an EMPTY preset list (never leaks the user rack-preset library)', () => {
    const input = showcaseInputFromRenders('My Cat', [source()], new Date('2026-07-08T00:00:00Z'));
    const parsed = JSON.parse(Buffer.from(input.lumen!.base64, 'base64').toString('utf-8'));
    expect(parsed.rackPresets).toEqual([]);
  });

  it('throws on no renders', () => {
    expect(() => showcaseInputFromRenders('X', [], new Date())).toThrow(/no render/i);
  });
});

describe('end-to-end remix chain', () => {
  it('embedded .lumen extracted from the generated showcase parses via parseLumenFile', () => {
    const input = showcaseInputFromRenders('Cat', [source()], new Date('2026-07-08T00:00:00Z'));
    const { html } = buildShowcaseHtml(input);
    const b64 = html.match(/id="lumen-data"[^>]*>([^<]+)</)![1].trim();
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const parsed = parseLumenFile(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.workflow.id).toBe('w1');
      expect(parsed.file.workflow.nodes).toHaveLength(1);
    }
  });
});

describe('utf8ToBase64', () => {
  it('round-trips unicode', () => {
    const s = 'néon 🐱 & <cat>';
    expect(Buffer.from(utf8ToBase64(s), 'base64').toString('utf-8')).toBe(s);
  });
});
