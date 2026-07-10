import { describe, expect, it } from 'vitest';
import { defaultShares, hydrateShares, addShare, removeShare, type PublishedShare } from '../src/state/shares';

const sample: PublishedShare = { id: 'a', title: 'Neon cat', url: 'https://x/neon.html', path: 'neon.html', token: 't', kind: 'gallery', sourceId: 'g1', publishedAt: 100 };

describe('shares slice', () => {
  it('defaultShares is empty', () => {
    expect(defaultShares()).toEqual([]);
  });

  it('hydrateShares keeps well-formed entries and drops malformed ones', () => {
    const persisted = [
      sample,
      { id: 'b', title: 'no token', url: 'https://x/b.html', path: 'b.html', kind: 'project', publishedAt: 1 }, // missing token
      { id: 'c', title: 'bad kind', url: 'https://x/c.html', path: 'c.html', token: 't', kind: 'nope', publishedAt: 1 }, // bad kind
      'garbage',
      null,
    ];
    const out = hydrateShares(persisted);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('hydrateShares tolerates non-arrays', () => {
    expect(hydrateShares(undefined)).toEqual([]);
    expect(hydrateShares({})).toEqual([]);
  });

  it('addShare prepends a new share with the given id + timestamp', () => {
    const list = addShare([sample], { title: 'Two', url: 'https://x/2.html', path: '2.html', token: 't2', kind: 'project', sourceId: 'p1' }, 'id2', 200);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'id2', title: 'Two', publishedAt: 200, kind: 'project' });
    expect(list[1].id).toBe('a');
  });

  it('removeShare drops by id and is a no-op for unknown ids', () => {
    expect(removeShare([sample], 'a')).toEqual([]);
    expect(removeShare([sample], 'zzz')).toEqual([sample]);
  });
});

import { persistedProjection } from '../src/state/persistence';
import { useStudio } from '../src/state/store';

describe('shares — store + persistence integration', () => {
  it('recordPublishedShare adds a row; removePublishedShare drops it', () => {
    const store = useStudio.getState();
    const before = store.publishedShares.length;
    store.recordPublishedShare({ title: 'Rec', url: 'https://x/r.html', path: 'r.html', token: 'tk', kind: 'gallery', sourceId: 'g9' });
    const added = useStudio.getState().publishedShares;
    expect(added.length).toBe(before + 1);
    expect(added[0]).toMatchObject({ title: 'Rec', path: 'r.html', kind: 'gallery' });
    expect(typeof added[0].id).toBe('string');
    expect(added[0].id.length).toBeGreaterThan(0);

    useStudio.getState().removePublishedShare(added[0].id);
    expect(useStudio.getState().publishedShares.find((s) => s.id === added[0].id)).toBeUndefined();
  });

  it('persistedProjection round-trips publishedShares under `shares`', () => {
    const proj = persistedProjection({
      // minimal shape — only publishedShares matters here; the projection reads the rest
      // straight through from the live store state passed by the subscription.
      ...useStudio.getState(),
      publishedShares: [{ id: 'p1', title: 'T', url: 'https://x/p.html', path: 'p.html', token: 'k', kind: 'project', publishedAt: 5 }],
    } as Parameters<typeof persistedProjection>[0]);
    expect(proj.shares).toEqual([{ id: 'p1', title: 'T', url: 'https://x/p.html', path: 'p.html', token: 'k', kind: 'project', publishedAt: 5 }]);
  });
});
