import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/core/creative/brain';
import type { AnalysisContext, RenderInfo } from '../src/core/creative/context';
import { classifyAspect } from '../src/core/creative/context';
import { detectMissing, summarizeMissing } from '../src/core/creative/missing';
import { scanEntropy, summarizeEntropy, STALE_PROMPT_DAYS } from '../src/core/creative/entropy';
import { scoreReadiness } from '../src/core/creative/readiness';
import { nextAction, rankByUrgency } from '../src/core/creative/nextAction';
import { critiqueProject } from '../src/core/creative/critic';
import { collectProof } from '../src/core/creative/proof';
import type { ProjectBrain } from '../src/core/creative/types';

const NOW = new Date('2026-07-07T12:00:00.000Z');

function mkRender(over: Partial<RenderInfo> = {}): RenderInfo {
  return {
    id: `r_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: NOW.toISOString(),
    aspect: '1:1',
    labeled: true,
    signature: `sig_${Math.random()}`,
    prompt: 'a prompt',
    linkedToProject: true,
    ...over,
  };
}

function ctxOf(renders: RenderInfo[]): AnalysisContext {
  return { renders, knownModelIds: new Set(['ckpt-lumen-xl']) };
}

/** A fully release-ready brain that references the given render ids. */
function readyBrain(renderIds: { logo: string; a16: string; a1: string; a9: string }): ProjectBrain {
  const b = createBrain('Aurora', 'brand', NOW);
  return {
    ...b,
    status: 'release-ready',
    identity: { logline: 'A glowing typeface.', audience: 'designers', promise: 'glow' },
    style: { styleTags: ['luminous', 'calm', 'editorial'], palette: ['#34d6f4', '#a78bfa'], mood: 'calm' },
    activeGoals: ['ship it'],
    assets: [{ id: 'as1', label: 'Logo', kind: 'logo', galleryId: renderIds.logo, status: 'ok', addedAt: NOW.toISOString() }],
    prompts: [{ id: 'p1', text: 'a prompt', addedAt: NOW.toISOString(), lastProducedAt: NOW.toISOString() }],
    renders: [renderIds.logo, renderIds.a16, renderIds.a1, renderIds.a9],
    recipes: ['rec1'],
    exports: [{ id: 'e1', kind: 'release-pack', label: 'pack', fileName: 'pack.zip', at: NOW.toISOString() }],
    copy: {
      shortDescription: 'short', longDescription: 'long', githubDescription: 'gh',
      readmeSection: '# Aurora', pressSummary: 'press', socialCaptions: ['cap'],
    },
    publishedLinks: [{ id: 'l1', label: 'site', url: 'https://x', addedAt: NOW.toISOString() }],
  };
}

describe('classifyAspect', () => {
  it('classifies the three launch aspects', () => {
    expect(classifyAspect(1280, 720)).toBe('16:9');
    expect(classifyAspect(1024, 1024)).toBe('1:1');
    expect(classifyAspect(720, 1280)).toBe('9:16');
    expect(classifyAspect(1000, 300)).toBe('other');
  });
});

describe('missing-piece detector', () => {
  it('detects at least 10 meaningful gap kinds on an empty brain', () => {
    const b = createBrain('Empty', 'artwork', NOW);
    const items = detectMissing(b, ctxOf([]));
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(10);
    // Spot-check specific required kinds.
    for (const k of ['no-identity', 'no-logo', 'no-promo-16x9', 'no-promo-1x1', 'no-promo-9x16', 'no-short-description', 'no-long-description', 'no-social-captions', 'no-readme-copy', 'no-release-zip', 'no-export-folder']) {
      expect(kinds.has(k as never)).toBe(true);
    }
    expect(summarizeMissing(items).blockers).toBeGreaterThan(0);
  });

  it('flags render-missing-lineage and prompt-without-output', () => {
    const r = mkRender({ id: 'r1', prompt: '' });
    const b: ProjectBrain = {
      ...createBrain('X', 'artwork', NOW),
      renders: ['r1'],
      prompts: [{ id: 'p1', text: 'unrendered idea', addedAt: NOW.toISOString() }],
    };
    const items = detectMissing(b, ctxOf([r]));
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has('render-missing-lineage')).toBe(true);
    expect(kinds.has('prompt-without-output')).toBe(true);
  });

  it('a release-ready brain has no blockers', () => {
    const logo = mkRender({ id: 'g_logo', aspect: '1:1' });
    const a16 = mkRender({ id: 'g_16', aspect: '16:9' });
    const a1 = mkRender({ id: 'g_1', aspect: '1:1' });
    const a9 = mkRender({ id: 'g_9', aspect: '9:16' });
    const b = readyBrain({ logo: 'g_logo', a16: 'g_16', a1: 'g_1', a9: 'g_9' });
    const items = detectMissing(b, ctxOf([logo, a16, a1, a9]));
    expect(summarizeMissing(items).blockers).toBe(0);
  });
});

describe('entropy scan', () => {
  it('finds duplicates, orphans, broken assets, stale prompts, unused + unlabeled renders', () => {
    const dupA = mkRender({ id: 'd1', signature: 'same', linkedToProject: true });
    const dupB = mkRender({ id: 'd2', signature: 'same', linkedToProject: true });
    const unused = mkRender({ id: 'u1', signature: 'uniqueU', linkedToProject: false, labeled: false });
    const staleDate = new Date(NOW.getTime() - (STALE_PROMPT_DAYS + 5) * 86_400_000).toISOString();
    const b: ProjectBrain = {
      ...createBrain('Messy', 'campaign', NOW),
      renders: ['d1', 'd2', 'missing_render'],
      assets: [{ id: 'as1', label: 'broken', kind: 'promo', path: 'x', status: 'broken', addedAt: NOW.toISOString() }],
      prompts: [{ id: 'p1', text: 'old idea', addedAt: staleDate }],
    };
    const items = scanEntropy([b], ctxOf([dupA, dupB, unused]), NOW);
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has('duplicate-render')).toBe(true);
    expect(kinds.has('orphaned-render-link')).toBe(true);
    expect(kinds.has('broken-asset')).toBe(true);
    expect(kinds.has('stale-prompt')).toBe(true);
    expect(kinds.has('unused-render')).toBe(true);
    expect(kinds.has('unlabeled-render')).toBe(true);
    // Campaign missing variants (only 1:1 present -> missing 16:9 + 9:16).
    expect(kinds.has('campaign-missing-variants')).toBe(true);
    // Every entropy item carries at least one recommended action.
    expect(items.every((i) => i.actions.length > 0)).toBe(true);
  });

  it('a clean linked+labeled render produces no entropy', () => {
    const clean = mkRender({ id: 'c1', signature: 'uniq', labeled: true, linkedToProject: true });
    const b: ProjectBrain = { ...createBrain('Clean', 'artwork', NOW), renders: ['c1'], exports: [{ id: 'e', kind: 'zip', label: 'z', fileName: 'z.zip', at: NOW.toISOString() }] };
    const items = scanEntropy([b], ctxOf([clean]), NOW);
    expect(summarizeEntropy(items).total).toBe(0);
  });
});

describe('readiness scoring', () => {
  it('a release-ready brain scores much higher than an empty one', () => {
    const empty = scoreReadiness(createBrain('E', 'artwork', NOW), ctxOf([]));
    const logo = mkRender({ id: 'g_logo' }), a16 = mkRender({ id: 'g_16', aspect: '16:9' }), a1 = mkRender({ id: 'g_1' }), a9 = mkRender({ id: 'g_9', aspect: '9:16' });
    const ready = scoreReadiness(readyBrain({ logo: 'g_logo', a16: 'g_16', a1: 'g_1', a9: 'g_9' }), ctxOf([logo, a16, a1, a9]));
    expect(empty.score).toBeLessThan(30);
    expect(ready.score).toBeGreaterThan(80);
    expect(ready.dimensions.launchReadiness).toBeGreaterThan(empty.dimensions.launchReadiness);
  });
});

describe('next best action engine', () => {
  it('recommends Create Project Brief when there is no identity', () => {
    expect(nextAction(createBrain('X', 'artwork', NOW), ctxOf([])).id).toBe('create-brief');
  });

  it('recommends Repair Project Links when links are broken (highest priority)', () => {
    const b: ProjectBrain = { ...createBrain('X', 'artwork', NOW), identity: { logline: 'has one', audience: '', promise: '' }, renders: ['gone'] };
    expect(nextAction(b, ctxOf([])).id).toBe('repair-links');
  });

  it('recommends Generate Variants when prompts exist but no renders', () => {
    const b: ProjectBrain = { ...createBrain('X', 'artwork', NOW), identity: { logline: 'l', audience: '', promise: '' }, prompts: [{ id: 'p', text: 't', addedAt: NOW.toISOString() }] };
    expect(nextAction(b, ctxOf([])).id).toBe('generate-variants');
  });

  it('does NOT count an "other"-aspect render toward the three launch aspects (regression)', () => {
    // 16:9 + 1:1 + a 4:5 "other" render → 9:16 is still genuinely missing.
    const r16 = mkRender({ id: 'r1', aspect: '16:9' });
    const r1 = mkRender({ id: 'r2', aspect: '1:1' });
    const rOther = mkRender({ id: 'r3', aspect: 'other' });
    const b: ProjectBrain = {
      ...createBrain('X', 'artwork', NOW),
      identity: { logline: 'l', audience: '', promise: '' },
      renders: ['r1', 'r2', 'r3'],
    };
    expect(nextAction(b, ctxOf([r16, r1, rOther])).id).toBe('create-aspect-variants');
  });

  it('recommends Build Release Pack when assets exist but no kit', () => {
    const r = mkRender({ id: 'r1', aspect: '16:9' }), r2 = mkRender({ id: 'r2', aspect: '1:1' }), r3 = mkRender({ id: 'r3', aspect: '9:16' });
    const b: ProjectBrain = {
      ...createBrain('X', 'artwork', NOW),
      identity: { logline: 'l', audience: '', promise: '' },
      renders: ['r1', 'r2', 'r3'],
    };
    expect(nextAction(b, ctxOf([r, r2, r3])).id).toBe('build-release-pack');
  });

  it('rankByUrgency puts broken-link projects first', () => {
    const broken: ProjectBrain = { ...createBrain('Broken', 'artwork', NOW), identity: { logline: 'l', audience: '', promise: '' }, renders: ['gone'] };
    const ok = createBrain('Ok', 'artwork', NOW);
    const ranked = rankByUrgency([ok, broken], ctxOf([]));
    expect(ranked[0].brain.id).toBe(broken.id);
  });
});

describe('redteam critic', () => {
  it('produces strengths, weaknesses, risks, fixes, and a next action', () => {
    const report = critiqueProject(createBrain('X', 'artwork', NOW), ctxOf([]), NOW);
    expect(report.strengths.length).toBeGreaterThan(0);
    expect(report.weaknesses.length).toBeGreaterThan(0);
    expect(report.risks.length).toBeGreaterThan(0);
    expect(report.fixes.length).toBeGreaterThan(0);
    expect(report.nextAction).toBeTruthy();
    expect(report.readiness).toBeGreaterThanOrEqual(0);
    expect(report.readiness).toBeLessThanOrEqual(100);
  });
});

describe('proof mode', () => {
  it('separates exports, links, and shipped renders', () => {
    const b = readyBrain({ logo: 'g1', a16: 'g1', a1: 'g1', a9: 'g1' });
    const proof = collectProof([b], (id) => id === 'g1');
    expect(proof.exports).toBe(1);
    expect(proof.links).toBe(1);
    expect(proof.shippedRenders).toBeGreaterThan(0);
    expect(proof.shippedProjects).toBe(1);
  });

  it('is empty for a brand-new project', () => {
    const proof = collectProof([createBrain('X', 'artwork', NOW)], () => false);
    expect(proof.artifacts).toHaveLength(0);
  });
});
