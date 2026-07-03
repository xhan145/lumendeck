import { beforeEach, describe, expect, it } from 'vitest';
import { findNode } from '../src/core/workflow';
import { useStudio } from '../src/state/store';

describe('studio store — recipe/graph single-object invariant', () => {
  beforeEach(() => {
    useStudio.getState().resetWorkflow();
  });

  it('a param edit is visible to both views via the same workflow object', () => {
    const store = useStudio.getState();
    const prompt = findNode(store.workflow, 'prompt')!;
    store.updateParam(prompt.id, 'positive', 'synced everywhere');

    const after = useStudio.getState();
    // Recipe view projection reads nodes by kind; graph view reads nodes by id —
    // both must observe the same object instance.
    const viaKind = findNode(after.workflow, 'prompt')!;
    const viaId = after.workflow.nodes.find((n) => n.id === prompt.id)!;
    expect(viaKind).toBe(viaId);
    expect(viaKind.params.positive).toBe('synced everywhere');
  });

  it('graph edits (add/connect) change the same workflow the recipe reads', () => {
    const store = useStudio.getState();
    const before = useStudio.getState().workflow.version;
    store.addCapsule('control', 10, 10);
    expect(useStudio.getState().workflow.version).toBeGreaterThan(before);
    expect(useStudio.getState().workflow.nodes.filter((n) => n.kind === 'control')).toHaveLength(2);
  });

  it('health recomputes on edit', () => {
    const store = useStudio.getState();
    const model = findNode(store.workflow, 'model')!;
    expect(useStudio.getState().health.some((i) => i.code === 'missing-model')).toBe(true);
    store.updateParam(model.id, 'assetId', 'ckpt-lumen-xl');
    expect(useStudio.getState().health.some((i) => i.code === 'missing-model')).toBe(false);
  });

  it('rack presets save and apply', () => {
    const store = useStudio.getState();
    store.setRackSlots([
      { assetId: 'lora-neon-bloom', weight: 0.7, enabled: true },
      { assetId: 'lora-inkwash', weight: 0.4, enabled: true },
    ]);
    store.saveRackPreset('Neon Ink');
    useStudio.getState().setRackSlots([]);
    expect(useStudio.getState().rackSlots()).toHaveLength(0);

    const preset = useStudio.getState().rackPresets.find((p) => p.name === 'Neon Ink')!;
    useStudio.getState().applyRackPreset(preset.id);
    const slots = useStudio.getState().rackSlots();
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ assetId: 'lora-neon-bloom', weight: 0.7 });

    useStudio.getState().deleteRackPreset(preset.id);
    expect(useStudio.getState().rackPresets.find((p) => p.id === preset.id)).toBeUndefined();
  });
});
