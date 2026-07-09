import { describe, expect, it } from 'vitest';
import { renderConstellationSvg } from '../src/core/share/showcaseSvg';
import type { Workflow } from '../src/core/types';

const graph: Workflow = {
  id: 'w1',
  name: 'Test',
  version: 1,
  schemaVersion: 1,
  nodes: [
    { id: 'prompt', kind: 'prompt', x: 40, y: 60, params: {} },
    { id: 'sampler', kind: 'sampler', x: 620, y: 240, params: {} },
  ],
  edges: [{ id: 'e1', from: { node: 'prompt', socket: 'out' }, to: { node: 'sampler', socket: 'in' } }],
};

describe('renderConstellationSvg', () => {
  it('renders one node marker per node and a wire per edge', () => {
    const svg = renderConstellationSvg(graph);
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<circle/g) ?? []).length).toBe(2);
    expect((svg.match(/<line|<path/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(svg).toContain('radialGradient'); // on-brand orb gradient defs
  });

  it('returns empty string for an empty graph', () => {
    expect(renderConstellationSvg({ ...graph, nodes: [], edges: [] })).toBe('');
  });

  it('is deterministic for a fixed graph', () => {
    expect(renderConstellationSvg(graph)).toBe(renderConstellationSvg(graph));
  });

  it('never emits a <script> or external reference', () => {
    const svg = renderConstellationSvg(graph);
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/src="http|href="http|url\(http/);
  });

  it('drops an edge whose endpoint node is missing (no crash)', () => {
    const svg = renderConstellationSvg({
      ...graph,
      edges: [{ id: 'bad', from: { node: 'ghost', socket: 'o' }, to: { node: 'sampler', socket: 'i' } }],
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<line/g) ?? []).length).toBe(0);
  });
});
