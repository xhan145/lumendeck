/**
 * Next Best Action engine. A deterministic, ordered rule set: the first rule
 * whose condition matches wins. Rules are ordered from "most foundational gap"
 * to "victory lap" so the recommendation always points at the true bottleneck.
 *
 * This is intentionally local and explainable — every recommendation carries the
 * reason it fired.
 */
import type { AnalysisContext } from './context';
import { indexRenders } from './context';
import type { NextAction, ProjectBrain } from './types';
import { scoreReadiness } from './readiness';

interface Rule {
  id: NextAction['id'];
  /** true => this rule fires */
  when: (b: ProjectBrain, ctx: AnalysisContext) => boolean;
  build: (b: ProjectBrain) => NextAction;
}

function hasBrokenLinks(b: ProjectBrain, ctx: AnalysisContext): boolean {
  const idx = indexRenders(ctx);
  const brokenAsset = b.assets.some((a) => !a.archived && (a.status === 'broken' || (a.galleryId != null && !idx.has(a.galleryId))));
  const orphanRender = b.renders.some((id) => !idx.has(id));
  return brokenAsset || orphanRender;
}

function linkedRenderCount(b: ProjectBrain, ctx: AnalysisContext): number {
  const idx = indexRenders(ctx);
  return b.renders.filter((id) => idx.has(id)).length;
}

/** The set of the three launch aspects a project's renders actually cover (excludes 'other'). */
function aspectCoverage(b: ProjectBrain, ctx: AnalysisContext): Set<string> {
  const idx = indexRenders(ctx);
  const present = new Set(b.renders.map((id) => idx.get(id)?.aspect));
  return new Set((['16:9', '1:1', '9:16'] as const).filter((a) => present.has(a)));
}

/** Ordered rules — first match wins. */
const RULES: Rule[] = [
  {
    id: 'repair-links',
    when: (b, ctx) => hasBrokenLinks(b, ctx),
    build: () => ({
      id: 'repair-links',
      title: 'Repair Project Links',
      reason: 'Some assets or render links are broken. Fix them before shipping.',
      targetView: 'entropy',
    }),
  },
  {
    id: 'create-brief',
    when: (b) => !b.identity.logline.trim(),
    build: () => ({
      id: 'create-brief',
      title: 'Create Project Brief',
      reason: 'This project has no core identity yet — define what it is and who it is for.',
      targetView: 'projects',
    }),
  },
  {
    id: 'add-prompts',
    when: (b) => b.prompts.length === 0 && b.renders.length === 0,
    build: () => ({
      id: 'add-prompts',
      title: 'Add Prompts',
      reason: 'There are no prompts or renders yet. Start by drafting a prompt in the Graph.',
      targetView: 'graph',
    }),
  },
  {
    id: 'generate-variants',
    when: (b, ctx) => b.prompts.length > 0 && linkedRenderCount(b, ctx) === 0,
    build: () => ({
      id: 'generate-variants',
      title: 'Generate Variants',
      reason: 'You have prompts but no renders. Generate variants to see them realized.',
      targetView: 'graph',
    }),
  },
  {
    id: 'create-aspect-variants',
    when: (b, ctx) => linkedRenderCount(b, ctx) > 0 && aspectCoverage(b, ctx).size < 3,
    build: () => ({
      id: 'create-aspect-variants',
      title: 'Create 16:9, 1:1, and 9:16',
      reason: 'You have renders but not every export aspect. Create the missing promo variants.',
      targetView: 'graph',
    }),
  },
  {
    id: 'build-release-pack',
    when: (b) => (b.assets.length > 0 || b.renders.length > 0) && !b.exports.some((e) => e.kind === 'release-pack' || e.kind === 'zip'),
    build: () => ({
      id: 'build-release-pack',
      title: 'Build Release Pack',
      reason: 'You have assets but no release kit. Assemble a structured release pack.',
      targetView: 'proof',
    }),
  },
  {
    id: 'write-social-captions',
    when: (b) => b.exports.length > 0 && b.copy.socialCaptions.length === 0,
    build: () => ({
      id: 'write-social-captions',
      title: 'Generate Social Captions',
      reason: 'You have a release kit but no social copy. Draft launch captions.',
      targetView: 'projects',
    }),
  },
  {
    id: 'review-critique',
    when: (b, ctx) => scoreReadiness(b, ctx).score < 80 && b.status !== 'shipped',
    build: () => ({
      id: 'review-critique',
      title: 'Review Project Critique',
      reason: 'Readiness is below 80%. Run the Redteam critic to see what is holding it back.',
      targetView: 'projects',
    }),
  },
  {
    id: 'mark-shipped',
    when: (b) => b.status !== 'shipped' && b.status !== 'archived',
    build: () => ({
      id: 'mark-shipped',
      title: 'Mark as Shipped',
      reason: 'This project is release-ready. Record the launch and move it to Proof.',
      targetView: 'projects',
    }),
  },
];

/** The single top recommendation for a project. */
export function nextAction(brain: ProjectBrain, ctx: AnalysisContext): NextAction {
  for (const rule of RULES) {
    if (rule.when(brain, ctx)) return rule.build(brain);
  }
  return {
    id: 'mark-shipped',
    title: 'All clear',
    reason: 'This project is shipped and healthy. Nothing needs attention.',
    targetView: 'proof',
  };
}

/**
 * Rank projects by urgency for Mission Control: broken links first, then lowest
 * readiness. Returns the brains paired with their next action.
 */
export function rankByUrgency(
  brains: ProjectBrain[],
  ctx: AnalysisContext,
): { brain: ProjectBrain; action: NextAction; readiness: number }[] {
  return brains
    .map((brain) => ({ brain, action: nextAction(brain, ctx), readiness: scoreReadiness(brain, ctx).score }))
    .sort((a, b) => {
      const aBroken = hasBrokenLinks(a.brain, ctx) ? 0 : 1;
      const bBroken = hasBrokenLinks(b.brain, ctx) ? 0 : 1;
      if (aBroken !== bBroken) return aBroken - bBroken;
      return a.readiness - b.readiness;
    });
}
