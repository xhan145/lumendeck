import { describe, expect, it } from 'vitest';
import { CAPSULES, CAPSULE_KINDS, defaultParams } from '../src/core/capsules';

describe('capsule registry', () => {
  it('defines all nine capsules', () => {
    expect(CAPSULE_KINDS.sort()).toEqual(
      ['canvas', 'control', 'export', 'loraRack', 'manifest', 'model', 'prompt', 'queue', 'sampler'],
    );
  });

  it('every param has a default and unique id', () => {
    for (const kind of CAPSULE_KINDS) {
      const def = CAPSULES[kind];
      const ids = def.params.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of def.params) {
        expect(p.default, `${kind}.${p.id} default`).not.toBeUndefined();
      }
    }
  });

  it('socket ids are unique per direction', () => {
    for (const kind of CAPSULE_KINDS) {
      const def = CAPSULES[kind];
      for (const list of [def.inputs, def.outputs]) {
        const ids = list.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('defaultParams clones array defaults', () => {
    const a = defaultParams('loraRack');
    const b = defaultParams('loraRack');
    expect(a.slots).not.toBe(b.slots);
  });
});
