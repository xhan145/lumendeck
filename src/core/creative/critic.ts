/**
 * Redteam project critic. A deterministic, local-first critique built entirely
 * from existing metadata (no cloud calls, no AI required). It reviews the seven
 * readiness dimensions and turns them into strengths / weaknesses / risks /
 * fixes plus the single next action.
 */
import type { AnalysisContext } from './context';
import type { CritiqueReport, ProjectBrain } from './types';
import { scoreReadiness } from './readiness';
import { detectMissing } from './missing';
import { scanEntropy } from './entropy';
import { nextAction } from './nextAction';

/** A dimension at or above this reads as a strength; below the low mark, a weakness. */
const STRONG = 75;
const WEAK = 45;

export function critiqueProject(brain: ProjectBrain, ctx: AnalysisContext, now: Date): CritiqueReport {
  const { score, dimensions } = scoreReadiness(brain, ctx);
  const missing = detectMissing(brain, ctx);
  const entropy = scanEntropy([brain], ctx, now).filter((e) => e.projectId === brain.id);

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const risks: string[] = [];
  const fixes: string[] = [];

  const label: Record<keyof typeof dimensions, string> = {
    visualConsistency: 'Visual consistency',
    assetCompleteness: 'Asset completeness',
    promptQuality: 'Prompt quality',
    exportReadiness: 'Export readiness',
    fileHygiene: 'File hygiene',
    launchReadiness: 'Launch readiness',
    reusePotential: 'Reuse potential',
  };

  (Object.keys(dimensions) as (keyof typeof dimensions)[]).forEach((key) => {
    const v = dimensions[key];
    if (v >= STRONG) strengths.push(`${label[key]} is strong (${v}/100).`);
    else if (v < WEAK) weaknesses.push(`${label[key]} is weak (${v}/100).`);
  });

  // Concrete strengths from real content, so the critique isn't only numeric.
  if (brain.recipes.length > 0) strengths.push(`${brain.recipes.length} reusable recipe${brain.recipes.length > 1 ? 's' : ''} linked — good leverage for the next project.`);
  if (brain.exports.length > 0) strengths.push(`${brain.exports.length} concrete export${brain.exports.length > 1 ? 's' : ''} already shipped.`);
  if (strengths.length === 0) strengths.push('Fresh project — a clean slate with no debt yet.');

  // Weaknesses & fixes from the missing-piece detector (blockers first).
  const blockers = missing.filter((m) => m.severity === 'blocker');
  for (const m of blockers) {
    weaknesses.push(`${m.label}: ${m.detail}`);
    fixes.push(fixForMissing(m.kind));
  }
  const warns = missing.filter((m) => m.severity === 'warn').slice(0, 4);
  for (const m of warns) fixes.push(fixForMissing(m.kind));

  // Risks from entropy (disorder that will bite later) + launch-gate risks.
  const highEntropy = entropy.filter((e) => e.severity === 'high');
  for (const e of highEntropy) risks.push(`${e.label}: ${e.detail}`);
  if (dimensions.fileHygiene < WEAK) risks.push('Low file hygiene — broken or orphaned links will erode trust in the archive.');
  if (brain.status === 'shipped' && score < 70) risks.push('Marked shipped while readiness is low — the public artifact may be incomplete.');
  if (dimensions.exportReadiness < WEAK && brain.status !== 'spark') risks.push('Approaching launch with thin export copy — the release will look unfinished.');
  if (risks.length === 0) risks.push('No structural risks detected in current metadata.');

  if (fixes.length === 0) fixes.push('No blocking gaps — polish copy and ship.');

  return {
    projectId: brain.id,
    generatedAt: now.toISOString(),
    readiness: score,
    dimensions,
    strengths: dedupe(strengths),
    weaknesses: dedupe(weaknesses),
    risks: dedupe(risks),
    fixes: dedupe(fixes),
    nextAction: nextAction(brain, ctx),
  };
}

function fixForMissing(kind: string): string {
  switch (kind) {
    case 'no-identity': return 'Write a one-sentence brief (logline, audience, promise).';
    case 'no-goals': return 'Add 1–3 active goals so progress has a target.';
    case 'no-logo': return 'Generate or link a logo asset.';
    case 'no-promo-16x9': return 'Render a 16:9 hero promo.';
    case 'no-promo-1x1': return 'Render a 1:1 square promo.';
    case 'no-promo-9x16': return 'Render a 9:16 vertical promo.';
    case 'no-short-description': return 'Draft a one-line short description.';
    case 'no-long-description': return 'Write the long-form description.';
    case 'no-social-captions': return 'Generate launch social captions.';
    case 'no-readme-copy': return 'Draft the README section.';
    case 'no-release-zip': return 'Build a release ZIP.';
    case 'no-export-folder': return 'Run Build Release Pack to assemble the export folder.';
    case 'broken-asset-path': return 'Repair or re-link the broken asset.';
    case 'render-missing-lineage': return 'Attach a prompt to the orphaned render.';
    case 'prompt-without-output': return 'Render the unused prompt or archive it.';
    default: return 'Address the flagged gap.';
  }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
