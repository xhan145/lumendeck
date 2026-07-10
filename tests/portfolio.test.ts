import { describe, expect, it } from 'vitest';
import { analyzePortfolio } from '../src/core/creative/portfolio';
import { createBrain } from '../src/core/creative/brain';
import { emptyContext } from '../src/core/creative/context';
import type { CreativeRecipe, ProjectBrain } from '../src/core/creative/types';

const ISO = (d: string) => new Date(d).toISOString();
const SEED = new Date('2026-06-01T00:00:00Z');

/** A valid brain from the real factory + overrides (keeps every required field). */
function brain(over: Partial<ProjectBrain>): ProjectBrain {
  return { ...createBrain('B', 'artwork', SEED), ...over };
}

const NOW = new Date('2026-07-08T00:00:00Z');

describe('analyzePortfolio', () => {
  it('ranks a stale, empty, unshipped project above a shipped one; shipped scores 0', () => {
    const needy = brain({ id: 'needy', name: 'Needy', status: 'spark', updatedAt: ISO('2026-06-01') });
    const done = brain({ id: 'done', name: 'Done', status: 'shipped', updatedAt: ISO('2026-07-07') });
    const r = analyzePortfolio([done, needy], [], emptyContext(), NOW);
    expect(r.triage[0].brainId).toBe('needy');
    expect(r.triage.find((t) => t.brainId === 'done')!.attention).toBe(0);
    expect(r.top!.brainId).toBe('needy');
  });

  it('top is null when every project is shipped/archived', () => {
    const r = analyzePortfolio(
      [brain({ id: 'a', status: 'shipped' }), brain({ id: 'c', status: 'archived' })],
      [],
      emptyContext(),
      NOW,
    );
    expect(r.top).toBeNull();
  });

  it('funnel counts by status with a ship rate', () => {
    const bs = [
      brain({ id: '1', status: 'shipped' }),
      brain({ id: '2', status: 'shipped' }),
      brain({ id: '3', status: 'spark' }),
    ];
    const r = analyzePortfolio(bs, [], emptyContext(), NOW);
    expect(r.funnel.total).toBe(3);
    expect(r.funnel.shipped).toBe(2);
    expect(r.funnel.shipRate).toBeCloseTo(2 / 3);
    expect(r.funnel.byStatus.shipped).toBe(2);
  });

  it('funnel shipRate is 0 for an empty portfolio (no divide-by-zero)', () => {
    const r = analyzePortfolio([], [], emptyContext(), NOW);
    expect(r.funnel.total).toBe(0);
    expect(r.funnel.shipRate).toBe(0);
    expect(r.top).toBeNull();
    expect(r.stall).toBeNull();
    expect(r.stale).toEqual([]);
  });

  it('stall picks a readiness dimension across unshipped projects', () => {
    const r = analyzePortfolio([brain({ id: 'x', status: 'in-progress' })], [], emptyContext(), NOW);
    expect(r.stall).not.toBeNull();
    expect(typeof r.stall!.dimension).toBe('string');
    expect(r.stall!.avgScore).toBeLessThanOrEqual(100);
    expect(r.stall!.affected).toBe(1);
  });

  it('stall is null when there are no unshipped projects', () => {
    const r = analyzePortfolio([brain({ id: 's', status: 'shipped' })], [], emptyContext(), NOW);
    expect(r.stall).toBeNull();
  });

  it('stale lists only aged, unshipped projects, oldest first', () => {
    const old = brain({ id: 'old', updatedAt: ISO('2026-06-01') }); // ~37d
    const fresh = brain({ id: 'fresh', updatedAt: ISO('2026-07-07') }); // 1d
    const shippedOld = brain({ id: 'so', status: 'shipped', updatedAt: ISO('2026-05-01') });
    const r = analyzePortfolio([fresh, old, shippedOld], [], emptyContext(), NOW);
    expect(r.stale.map((s) => s.brainId)).toEqual(['old']);
    expect(r.stale[0].daysSinceUpdate).toBeGreaterThanOrEqual(14);
  });

  it('topRecipes counts recipe references across brains and resolves names', () => {
    const recipes = [
      { id: 'r1', name: 'Neon' },
      { id: 'r2', name: 'Noir' },
    ] as CreativeRecipe[];
    const bs = [brain({ id: '1', recipes: ['r1', 'r2'] }), brain({ id: '2', recipes: ['r1'] })];
    const r = analyzePortfolio(bs, recipes, emptyContext(), NOW);
    expect(r.strengths.topRecipes[0]).toMatchObject({ id: 'r1', name: 'Neon', uses: 2 });
  });

  it('strongestType needs >=2 projects of a type; null otherwise', () => {
    const r = analyzePortfolio([brain({ id: 'a', type: 'artwork' })], [], emptyContext(), NOW);
    expect(r.strengths.strongestType).toBeNull();
  });

  it('velocity ignores a blank statusHistory.at and still counts the valid ship (order-independent)', () => {
    const withBlankFirst = brain({
      id: 'vb',
      createdAt: ISO('2026-07-06'),
      status: 'shipped',
      statusHistory: [
        { at: '', from: 'release-ready', to: 'shipped' },
        { at: ISO('2026-07-07'), from: 'release-ready', to: 'shipped' },
      ],
    });
    const r = analyzePortfolio([withBlankFirst], [], emptyContext(), NOW);
    expect(r.velocity.weeks.reduce((a, w) => a + w.shipped, 0)).toBe(1);
  });

  it('velocity buckets started (createdAt) and shipped (statusHistory->shipped) into 8 weeks', () => {
    const b = brain({
      id: 'v',
      createdAt: ISO('2026-07-06'),
      statusHistory: [{ at: ISO('2026-07-07'), from: 'release-ready', to: 'shipped' }],
      status: 'shipped',
    });
    const r = analyzePortfolio([b], [], emptyContext(), NOW);
    expect(r.velocity.weeks.length).toBe(8);
    expect(r.velocity.weeks.reduce((a, w) => a + w.started, 0)).toBe(1);
    expect(r.velocity.weeks.reduce((a, w) => a + w.shipped, 0)).toBe(1);
  });
});
