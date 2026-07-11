import { describe, it, expect } from 'vitest';
import { buildLumenConstellation } from '../src/components/constellation/data';
import { indexConstellation } from '../src/components/constellation/selection';
import type { ConstellationNode } from '../src/components/constellation/types';
import { CAPSULES, CAPSULE_KINDS } from '../src/core/capsules';
import type { ProjectBrain, CreativeRecipe } from '../src/core/creative/types';

const walk = (node: ConstellationNode, fn: (n: ConstellationNode, depth: number) => void, depth = 0) => {
  fn(node, depth);
  for (const c of node.children ?? []) walk(c, fn, depth + 1);
};

describe('buildLumenConstellation', () => {
  it('builds a valid tree from a completely empty store', () => {
    const root = buildLumenConstellation();
    expect(root.id).toBe('lumen');
    expect(root.children!.length).toBeGreaterThanOrEqual(9);
    walk(root, (n) => {
      expect(n.id.length).toBeGreaterThan(0);
      expect(n.label.length).toBeGreaterThan(0);
      expect(n.colors).toHaveLength(2);
      expect(n.colors[0].length).toBeGreaterThan(0);
    });
  });

  it('has globally unique ids (the selection index sees every node)', () => {
    const root = buildLumenConstellation();
    let count = 0;
    walk(root, () => count++);
    expect(indexConstellation(root).size).toBe(count);
  });

  it('maps every capsule under its category satellite', () => {
    const root = buildLumenConstellation();
    const studio = root.children!.find((c) => c.id === 'studio')!;
    const categories = new Set(CAPSULE_KINDS.map((k) => CAPSULES[k].category));
    expect(studio.children!.length).toBe(categories.size);
    const leaves = studio.children!.flatMap((c) => c.children ?? []);
    expect(leaves.length).toBe(CAPSULE_KINDS.length);
  });

  it('caps depth at 3 (root → area → group → leaf) so the sky stays legible', () => {
    let maxDepth = 0;
    walk(buildLumenConstellation(), (_n, d) => {
      maxDepth = Math.max(maxDepth, d);
    });
    expect(maxDepth).toBe(3);
  });

  it('backs the Open Core branch with the code-enforced invariants', () => {
    const open = buildLumenConstellation().children!.find((c) => c.id === 'open-core')!;
    const ids = (open.children ?? []).map((c) => c.id);
    expect(ids).toContain('open-local');
    expect(ids).toContain('open-telemetry');
    expect(ids).toContain('open-license');
    expect(open.children!.every((c) => c.type === 'evidence')).toBe(true);
  });

  it('resolves colors through the injected resolver (no raw var() reaches nodes)', () => {
    const root = buildLumenConstellation({ resolve: (c) => (c.startsWith('var(') ? '#123456' : c) });
    walk(root, (n) => {
      expect(n.colors[0].startsWith('var(')).toBe(false);
      expect(n.colors[1].startsWith('var(')).toBe(false);
    });
  });

  it('renders concept leaves when the creative slice is empty, live nodes when populated', () => {
    const empty = buildLumenConstellation();
    const emptyCreative = empty.children!.find((c) => c.id === 'creative')!;
    expect(emptyCreative.status).toBe('forming');
    expect(emptyCreative.children!.some((c) => c.id.startsWith('creative-'))).toBe(true);

    const brain = {
      id: 'b1',
      name: 'Nebula Runner',
      type: 'artwork',
      status: 'in-progress',
      identity: { logline: 'A chaotic nebula chase.' },
      style: { palette: ['#ff00aa'] },
      renders: ['r1', 'r2', 'r3'],
    } as unknown as ProjectBrain;
    const recipe = { id: 'rc1', name: 'Neon Poster', persona: 'Poster artist', successScore: 4 } as unknown as CreativeRecipe;
    const live = buildLumenConstellation({ brains: [brain], recipes: [recipe] });
    const creative = live.children!.find((c) => c.id === 'creative')!;
    const brainNode = creative.children!.find((c) => c.id === 'brain-b1')!;
    expect(brainNode.label).toBe('Nebula Runner');
    expect(brainNode.status).toBe('active');
    expect(brainNode.colors[0]).toBe('#ff00aa');
    expect(creative.children!.some((c) => c.id === 'recipe-rc1')).toBe(true);
  });

  it('maps gallery collections with counts and stays safe when empty', () => {
    const withCollections = buildLumenConstellation({
      galleryCount: 12,
      collections: [{ id: 'c1', name: 'Portraits', count: 7 }],
    });
    const gallery = withCollections.children!.find((c) => c.id === 'gallery')!;
    expect(gallery.children!.some((c) => c.id === 'collection-c1')).toBe(true);
    // 12 total − 7 categorized → the 5 null-collection renders surface honestly.
    const uncat = gallery.children!.find((c) => c.id === 'gallery-uncategorized')!;
    expect(uncat.description).toContain('5');
    expect(gallery.children!.some((c) => c.id === 'gallery-frontier')).toBe(false);
    expect(gallery.status).toBe('active');

    const empty = buildLumenConstellation().children!.find((c) => c.id === 'gallery')!;
    expect(empty.children!.length).toBeGreaterThan(0); // frontier placeholder, never bare
    expect(empty.children![0].id).toBe('gallery-frontier');
    expect(empty.status).toBe('forming');
  });

  it('never shows the first-render placeholder when uncategorized renders exist (Codex P2)', () => {
    // Fresh user: first render made, no collections yet (collectionId null default).
    const gallery = buildLumenConstellation({ galleryCount: 1, collections: [] })
      .children!.find((c) => c.id === 'gallery')!;
    expect(gallery.children!.some((c) => c.id === 'gallery-frontier')).toBe(false);
    const uncat = gallery.children!.find((c) => c.id === 'gallery-uncategorized')!;
    expect(uncat.description).toContain('1 render');
    expect(gallery.status).toBe('active');
  });
});
