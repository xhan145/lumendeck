import { beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '../src/state/store';
import { updateBrain } from '../src/core/creative/brain';
import { findNode } from '../src/core/workflow';

/** Reset the creative slice + workflow between tests (store is a module singleton). */
beforeEach(() => {
  useStudio.getState().resetWorkflow();
  useStudio.setState({ creative: { brains: [], recipes: [], activeProjectId: null, aiEnabled: false, seeded: false } });
});

describe('creative store — projects', () => {
  it('creates a project and sets it active', () => {
    const id = useStudio.getState().createProject('My Game', 'app');
    const state = useStudio.getState();
    expect(state.creative.brains).toHaveLength(1);
    expect(state.creative.brains[0].name).toBe('My Game');
    expect(state.creative.activeProjectId).toBe(id);
  });

  it('updates a brain through updateProjectBrain', () => {
    const id = useStudio.getState().createProject('X', 'artwork');
    useStudio.getState().updateProjectBrain(id, (b) => updateBrain(b, { status: 'polishing' }, new Date()));
    expect(useStudio.getState().creative.brains[0].status).toBe('polishing');
  });

  it('links and unlinks a render, recording events', () => {
    const id = useStudio.getState().createProject('X', 'artwork');
    useStudio.getState().linkRenderToProject(id, 'render_1');
    let brain = useStudio.getState().creative.brains[0];
    expect(brain.renders).toContain('render_1');
    expect(brain.events.some((e) => e.type === 'render-linked')).toBe(true);
    useStudio.getState().unlinkRenderFromProject(id, 'render_1');
    brain = useStudio.getState().creative.brains[0];
    expect(brain.renders).not.toContain('render_1');
  });

  it('deletes a project and reassigns the active id', () => {
    const a = useStudio.getState().createProject('A', 'artwork');
    const b = useStudio.getState().createProject('B', 'artwork');
    useStudio.getState().deleteProject(b);
    const state = useStudio.getState();
    expect(state.creative.brains.map((x) => x.id)).toEqual([a]);
    expect(state.creative.activeProjectId).toBe(a);
  });

  it('generateProjectCaptions fills social captions', () => {
    const id = useStudio.getState().createProject('Neon', 'app');
    useStudio.getState().updateProjectBrain(id, (b) => updateBrain(b, { identity: { logline: 'a neon game', audience: '', promise: '' } }, new Date()));
    useStudio.getState().generateProjectCaptions(id);
    expect(useStudio.getState().creative.brains[0].copy.socialCaptions.length).toBeGreaterThan(0);
  });

  it('markProjectShipped changes status to shipped', () => {
    const id = useStudio.getState().createProject('X', 'artwork');
    useStudio.getState().markProjectShipped(id);
    expect(useStudio.getState().creative.brains[0].status).toBe('shipped');
  });
});

describe('creative store — recipes', () => {
  it('creates, duplicates, and deletes recipes', () => {
    const id = useStudio.getState().createCreativeRecipe('Neon');
    expect(useStudio.getState().creative.recipes).toHaveLength(1);
    useStudio.getState().duplicateCreativeRecipe(id);
    expect(useStudio.getState().creative.recipes).toHaveLength(2);
    useStudio.getState().deleteCreativeRecipe(id);
    expect(useStudio.getState().creative.recipes).toHaveLength(1);
  });

  it('applyCreativeRecipe writes prompt + canvas into the workflow', () => {
    const id = useStudio.getState().createCreativeRecipe('Poster');
    useStudio.getState().updateCreativeRecipe(id, { promptTemplate: '{subject}, neon', negativePrompt: 'blur', aspectRatios: ['16:9'] });
    useStudio.getState().applyCreativeRecipe(id, 'a fox');
    const wf = useStudio.getState().workflow;
    const prompt = findNode(wf, 'prompt');
    const canvas = findNode(wf, 'canvas');
    expect(String(prompt?.params.positive)).toContain('a fox');
    expect(String(prompt?.params.positive)).toContain('neon');
    expect(canvas?.params.width).toBe(1280);
    expect(canvas?.params.height).toBe(720);
    // usage bumped
    expect(useStudio.getState().creative.recipes[0].timesUsed).toBe(1);
  });

  it('promoteToRecipe captures the live prompt into a new recipe', () => {
    const wf = useStudio.getState().workflow;
    const promptNode = findNode(wf, 'prompt')!;
    useStudio.getState().updateParam(promptNode.id, 'positive', 'glowing city');
    const rid = useStudio.getState().promoteToRecipe({ name: 'City' });
    const recipe = useStudio.getState().creative.recipes.find((r) => r.id === rid);
    expect(recipe?.promptTemplate).toBe('glowing city');
  });

  it('promoteToRecipe with explicit text uses it over the live prompt (regression)', () => {
    const promptNode = findNode(useStudio.getState().workflow, 'prompt')!;
    useStudio.getState().updateParam(promptNode.id, 'positive', 'live editor prompt');
    const rid = useStudio.getState().promoteToRecipe({ name: 'Stale', text: 'the stale prompt text' });
    const recipe = useStudio.getState().creative.recipes.find((r) => r.id === rid);
    expect(recipe?.promptTemplate).toBe('the stale prompt text');
  });
});

describe('creative store — analysis + entropy resolution', () => {
  it('analysisContext projects the gallery', () => {
    useStudio.setState({
      gallery: [{
        id: 'g1', dataUrl: 'x', createdAt: new Date().toISOString(), tags: ['a'], collectionId: null,
        manifest: { canvas: { width: 1280, height: 720 }, resolvedPrompt: 'p', prompt: 'p', seed: 1 } as never,
      }],
    });
    const ctx = useStudio.getState().analysisContext();
    expect(ctx.renders).toHaveLength(1);
    expect(ctx.renders[0].aspect).toBe('16:9');
    expect(ctx.renders[0].labeled).toBe(true);
  });

  it('resolveEntropyItem delete unlinks an orphaned render link', () => {
    const id = useStudio.getState().createProject('X', 'artwork');
    useStudio.getState().linkRenderToProject(id, 'gone');
    useStudio.getState().resolveEntropyItem(
      { id: 'ent1', kind: 'orphaned-render-link', severity: 'high', label: 'x', detail: 'y', projectId: id, ref: 'gone', actions: ['repair', 'delete'] },
      'repair',
    );
    expect(useStudio.getState().creative.brains[0].renders).not.toContain('gone');
  });

  it('resolveEntropyItem archive tags a gallery-global unlabeled render (regression)', async () => {
    useStudio.setState({
      gallery: [{ id: 'g1', dataUrl: 'x', createdAt: new Date().toISOString(), tags: [], collectionId: null, manifest: { canvas: { width: 1, height: 1 }, seed: 0, prompt: '', resolvedPrompt: '' } as never }],
    });
    useStudio.getState().resolveEntropyItem(
      { id: 'ent2', kind: 'unlabeled-render', severity: 'low', label: 'x', detail: 'y', ref: 'g1', actions: ['retag', 'archive'] },
      'archive',
    );
    // addTag is async write-through; wait a microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(useStudio.getState().gallery.find((g) => g.id === 'g1')?.tags).toContain('archived');
  });
});

describe('creative store — release pack + demo', () => {
  it('buildProjectReleasePack records an export on the brain', () => {
    const id = useStudio.getState().createProject('Ship It', 'app');
    const pack = useStudio.getState().buildProjectReleasePack(id);
    expect(pack).toBeTruthy();
    const brain = useStudio.getState().creative.brains[0];
    expect(brain.exports).toHaveLength(1);
    expect(brain.exports[0].kind).toBe('release-pack');
    expect(brain.events.some((e) => e.type === 'export-built')).toBe(true);
  });

  it('seedCreativeDemo adds the chaotic + release-ready demo projects', () => {
    useStudio.getState().seedCreativeDemo();
    const brains = useStudio.getState().creative.brains;
    expect(brains.length).toBeGreaterThanOrEqual(2);
    expect(brains.some((b) => b.name === 'Nebula Runner')).toBe(true);
    expect(brains.some((b) => b.name === 'Aurora Type' && b.status === 'release-ready')).toBe(true);
    expect(useStudio.getState().creative.seeded).toBe(true);
    // Idempotent: re-seeding does not duplicate.
    const before = useStudio.getState().creative.brains.length;
    useStudio.getState().seedCreativeDemo();
    expect(useStudio.getState().creative.brains.length).toBe(before);
  });
});
