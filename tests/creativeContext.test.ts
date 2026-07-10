import { describe, expect, it } from 'vitest';
import { buildAnalysisContext } from '../src/state/creative';
import type { GalleryItem } from '../src/state/store';
import type { ProjectBrain } from '../src/core/creative/types';

function item(over: Record<string, unknown>): GalleryItem {
  return {
    id: 'g1',
    createdAt: '2026-07-01T00:00:00.000Z',
    dataUrl: '',
    manifest: {
      prompt: 'neon glow, city',
      resolvedPrompt: 'neon glow, city',
      negativePrompt: 'blurry',
      seed: 1,
      canvas: { width: 512, height: 512 },
      sampler: { name: 'euler_a', steps: 20, cfg: 4 },
      model: { id: 'm', name: 'PonyXL', family: 'Pony', hash: 'x' },
      ...(over.render ? { render: over.render } : {}),
    },
    ...over,
  } as unknown as GalleryItem;
}

describe('buildAnalysisContext — craft enrichment', () => {
  it('projects model family, sampler, steps, cfg, negativePrompt from the manifest', () => {
    const ctx = buildAnalysisContext([item({ id: 'a' })], [], []);
    const r = ctx.renders[0];
    expect(r.modelFamily).toBe('Pony');
    expect(r.sampler).toBe('euler_a');
    expect(r.steps).toBe(20);
    expect(r.cfg).toBe(4);
    expect(r.negativePrompt).toBe('blurry');
    expect(r.fallback).toBe(false);
  });

  it('marks kept = tagged OR linked-to-project, and flags fallback renders', () => {
    const tagged = item({ id: 'tag', tags: ['keep'] });
    const linkedId = item({ id: 'lnk' });
    const fb = item({ id: 'fb', render: { mode: 'fallback' } });
    const brain = { id: 'p1', renders: ['lnk'], assets: [] } as unknown as ProjectBrain;
    const ctx = buildAnalysisContext([tagged, linkedId, fb], [brain], []);
    const byId = Object.fromEntries(ctx.renders.map((r) => [r.id, r]));
    expect(byId.tag.kept).toBe(true); // tagged
    expect(byId.lnk.kept).toBe(true); // linked to project
    expect(byId.fb.kept).toBe(false); // untouched
    expect(byId.fb.fallback).toBe(true);
  });
});
