import { describe, expect, it } from 'vitest';
import {
  buildProjectFile,
  createBrain,
  MAX_EVENTS,
  parseProjectFile,
  recordEvent,
  sanitizeBrain,
  touchOpened,
  updateBrain,
} from '../src/core/creative/brain';
import {
  applyRecipe,
  createRecipe,
  duplicateRecipe,
  markRecipeUsed,
  resolveRecipePrompt,
  sanitizeRecipe,
  updateRecipe,
} from '../src/core/creative/recipes';

const NOW = new Date('2026-07-07T12:00:00.000Z');
const LATER = new Date('2026-07-08T12:00:00.000Z');

describe('project brain lifecycle', () => {
  it('creates a brain with defaults and a created event', () => {
    const b = createBrain('Aurora', 'brand', NOW);
    expect(b.name).toBe('Aurora');
    expect(b.type).toBe('brand');
    expect(b.status).toBe('spark');
    expect(b.identity.logline).toBe('');
    expect(b.createdAt).toBe(NOW.toISOString());
    expect(b.events).toHaveLength(1);
    expect(b.events[0].type).toBe('created');
  });

  it('falls back to a placeholder name when blank', () => {
    expect(createBrain('   ', 'app', NOW).name).toBe('Untitled Project');
  });

  it('records events and bumps updatedAt', () => {
    const b = createBrain('X', 'artwork', NOW);
    const next = recordEvent(b, 'note', 'hello', LATER, 'ref1');
    expect(next.events).toHaveLength(2);
    expect(next.events[1]).toMatchObject({ type: 'note', label: 'hello', ref: 'ref1' });
    expect(next.updatedAt).toBe(LATER.toISOString());
  });

  it('ring-buffers events to MAX_EVENTS', () => {
    let b = createBrain('X', 'artwork', NOW);
    for (let i = 0; i < MAX_EVENTS + 50; i += 1) b = recordEvent(b, 'note', `e${i}`, NOW);
    expect(b.events.length).toBe(MAX_EVENTS);
    // The most recent event survives; the earliest are dropped.
    expect(b.events[b.events.length - 1].label).toBe(`e${MAX_EVENTS + 49}`);
  });

  it('updateBrain records status history + a status event on status change', () => {
    const b = createBrain('X', 'app', NOW);
    const next = updateBrain(b, { status: 'shipped' }, LATER);
    expect(next.status).toBe('shipped');
    expect(next.statusHistory).toHaveLength(1);
    expect(next.statusHistory[0]).toMatchObject({ from: 'spark', to: 'shipped' });
    expect(next.events.some((e) => e.type === 'status-changed')).toBe(true);
  });

  it('touchOpened updates lastOpenedAt but NOT updatedAt', () => {
    const b = createBrain('X', 'app', NOW);
    const opened = touchOpened(b, LATER);
    expect(opened.lastOpenedAt).toBe(LATER.toISOString());
    expect(opened.updatedAt).toBe(b.updatedAt);
  });

  it('round-trips through buildProjectFile / parseProjectFile', () => {
    const b = createBrain('Aurora', 'brand', NOW);
    const r = createRecipe('Neon', NOW);
    const withRecipe = { ...b, recipes: [r.id] };
    const file = buildProjectFile(withRecipe, [r], NOW);
    expect(file.recipes).toHaveLength(1);
    const parsed = parseProjectFile(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.brain.name).toBe('Aurora');
      expect(parsed.file.recipes).toHaveLength(1);
    }
  });

  it('rejects malformed project files without throwing', () => {
    expect(parseProjectFile('not json').ok).toBe(false);
    expect(parseProjectFile('{}').ok).toBe(false);
    expect(parseProjectFile(JSON.stringify({ kind: 'project-brain', schemaVersion: 1 })).ok).toBe(false);
  });

  it('sanitizeBrain repairs a malformed brain', () => {
    const dirty = { name: 'Z', type: 'nonsense', status: 'bogus', events: 'x' } as never;
    const clean = sanitizeBrain(dirty);
    expect(clean.type).toBe('exploration');
    expect(clean.status).toBe('spark');
    expect(Array.isArray(clean.events)).toBe(true);
    expect(clean.identity.logline).toBe('');
  });

  it('sanitizeBrain deep-repairs nested arrays so engines never crash (regression)', () => {
    const dirty = {
      name: 'Z',
      prompts: [{ id: 'p1', addedAt: '2020-01-01T00:00:00.000Z' }, null, 42], // missing text / junk members
      renders: ['ok', 123, null], // non-string ids
      assets: [{ id: 'a1' }, 'garbage'],
    } as never;
    const clean = sanitizeBrain(dirty);
    // Every prompt now has a string `text`; junk members dropped.
    expect(clean.prompts.every((p) => typeof p.text === 'string')).toBe(true);
    expect(clean.prompts).toHaveLength(1);
    // Only string render ids survive.
    expect(clean.renders).toEqual(['ok']);
    expect(clean.assets.every((a) => typeof a.label === 'string')).toBe(true);
  });

  it('parseProjectFile sanitizes imported recipes so a malformed recipe cannot crash the UI (regression)', () => {
    const file = {
      schemaVersion: 1, app: 'LumenDeck', kind: 'project-brain', savedAt: NOW.toISOString(),
      brain: { id: 'b1', name: 'X', events: [] },
      recipes: [{ id: 'r1', name: 'Bad' }, null], // missing arrays + a null
    };
    const parsed = parseProjectFile(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.recipes).toHaveLength(1);
      expect(Array.isArray(parsed.file.recipes[0].aspectRatios)).toBe(true);
      expect(Array.isArray(parsed.file.recipes[0].styleTags)).toBe(true);
    }
  });
});

describe('creative recipes', () => {
  it('creates with defaults and applies overrides', () => {
    const r = createRecipe('Neon Poster', NOW, { styleTags: ['neon'], aspectRatios: ['16:9'] });
    expect(r.name).toBe('Neon Poster');
    expect(r.styleTags).toEqual(['neon']);
    expect(r.aspectRatios).toEqual(['16:9']);
    expect(r.timesUsed).toBe(0);
  });

  it('duplicate resets usage and renames', () => {
    const r = markRecipeUsed(createRecipe('Neon', NOW), NOW);
    const copy = duplicateRecipe(r, LATER);
    expect(copy.name).toBe('Neon copy');
    expect(copy.id).not.toBe(r.id);
    expect(copy.timesUsed).toBe(0);
    expect(copy.lastUsedAt).toBeNull();
  });

  it('resolveRecipePrompt substitutes {subject} and appends style tags', () => {
    const r = createRecipe('X', NOW, { promptTemplate: '{subject}, glowing', styleTags: ['neon', 'dark'] });
    expect(resolveRecipePrompt(r, 'a cat')).toBe('a cat, glowing, neon, dark');
  });

  it('resolveRecipePrompt prepends subject when no placeholder', () => {
    const r = createRecipe('X', NOW, { promptTemplate: 'studio light', styleTags: [] });
    expect(resolveRecipePrompt(r, 'a mug')).toBe('a mug, studio light');
  });

  it('applyRecipe maps the first aspect to a canvas size', () => {
    const r = createRecipe('X', NOW, { promptTemplate: '{subject}', aspectRatios: ['16:9'], negativePrompt: 'blurry', modelId: 'm1' });
    const app = applyRecipe(r, 'castle');
    expect(app.prompt).toBe('castle');
    expect(app.negativePrompt).toBe('blurry');
    expect(app.modelId).toBe('m1');
    expect(app.canvas).toEqual({ width: 1280, height: 720 });
  });

  it('markRecipeUsed increments count and stamps lastUsedAt', () => {
    const r = markRecipeUsed(createRecipe('X', NOW), LATER);
    expect(r.timesUsed).toBe(1);
    expect(r.lastUsedAt).toBe(LATER.toISOString());
  });

  it('updateRecipe preserves id + createdAt', () => {
    const r = createRecipe('X', NOW);
    const u = updateRecipe(r, { name: 'Y' }, LATER);
    expect(u.id).toBe(r.id);
    expect(u.createdAt).toBe(r.createdAt);
    expect(u.name).toBe('Y');
    expect(u.updatedAt).toBe(LATER.toISOString());
  });

  it('sanitizeRecipe clamps score and filters invalid aspects', () => {
    const clean = sanitizeRecipe({ name: 'Z', successScore: 99, aspectRatios: ['16:9', 'bogus'] as never });
    expect(clean.successScore).toBe(5);
    expect(clean.aspectRatios).toEqual(['16:9']);
  });
});
