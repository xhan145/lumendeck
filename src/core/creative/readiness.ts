/**
 * Deterministic launch-readiness scoring. Pure function of a brain + its render
 * context — no cloud, no randomness. Powers the readiness ring on Mission
 * Control and the critic's dimension breakdown.
 */
import type { AnalysisContext } from './context';
import { indexRenders } from './context';
import type { ProjectBrain } from './types';

export interface ReadinessDimensions {
  visualConsistency: number;
  assetCompleteness: number;
  promptQuality: number;
  exportReadiness: number;
  fileHygiene: number;
  launchReadiness: number;
  reusePotential: number;
}

export interface ReadinessResult {
  /** 0..100 overall */
  score: number;
  dimensions: ReadinessDimensions;
}

const clamp100 = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export function scoreReadiness(brain: ProjectBrain, ctx: AnalysisContext): ReadinessResult {
  const idx = indexRenders(ctx);
  const linkedRenders = brain.renders.map((id) => idx.get(id)).filter(Boolean) as NonNullable<ReturnType<typeof idx.get>>[];

  // visual consistency — has a defined palette + style tags + a mood, plus real renders
  let visual = 0;
  if (brain.style.palette.length >= 2) visual += 40;
  else if (brain.style.palette.length === 1) visual += 20;
  if (brain.style.styleTags.length >= 3) visual += 35;
  else visual += brain.style.styleTags.length * 12;
  if (brain.style.mood.trim()) visual += 15;
  if (linkedRenders.length >= 3) visual += 10;
  const visualConsistency = clamp100(visual);

  // asset completeness — logo + three promo aspects + at least one reference
  const hasLogo = brain.assets.some((a) => a.kind === 'logo' && !a.archived && a.status === 'ok');
  const aspects = new Set(linkedRenders.map((r) => r.aspect));
  let assets = 0;
  if (hasLogo) assets += 30;
  assets += (['16:9', '1:1', '9:16'] as const).filter((a) => aspects.has(a)).length * 20;
  if (brain.assets.some((a) => a.kind === 'reference' && !a.archived)) assets += 10;
  const assetCompleteness = clamp100(assets);

  // prompt quality — has prompts, and they have produced outputs
  const total = brain.prompts.length;
  const withOutput = brain.prompts.filter((p) => {
    if (p.lastProducedAt) return true;
    const t = p.text.trim().toLowerCase();
    return linkedRenders.some((r) => r.prompt.trim().toLowerCase() === t);
  }).length;
  let prompt = 0;
  if (total > 0) {
    prompt += Math.min(40, total * 12);
    prompt += Math.round((withOutput / total) * 60);
  }
  const promptQuality = clamp100(prompt);

  // export readiness — copy filled in + an export built + a published link
  const copy = brain.copy;
  const copyPoints =
    (copy.shortDescription.trim() ? 12 : 0) +
    (copy.longDescription.trim() ? 12 : 0) +
    (copy.readmeSection.trim() ? 8 : 0) +
    (copy.socialCaptions.length ? 8 : 0);
  const hasExport = brain.exports.length > 0;
  const exportReadiness = clamp100(copyPoints + (hasExport ? 45 : 0) + (brain.publishedLinks.length ? 15 : 0));

  // file hygiene — penalize broken/orphaned assets + orphaned render links
  const activeAssets = brain.assets.filter((a) => !a.archived);
  const broken = activeAssets.filter((a) => a.status === 'broken' || (a.galleryId != null && !idx.has(a.galleryId))).length;
  const orphanLinks = brain.renders.filter((id) => !idx.has(id)).length;
  const problems = broken + orphanLinks;
  const surface = activeAssets.length + brain.renders.length;
  const fileHygiene = clamp100(surface === 0 ? 70 : 100 - (problems / surface) * 100);

  // reuse potential — recipes linked + prompts with lineage that could seed one
  let reuse = 0;
  reuse += Math.min(60, brain.recipes.length * 30);
  reuse += Math.min(40, withOutput * 10);
  const reusePotential = clamp100(reuse);

  // launch readiness — identity + goals + assets + exports gates
  let launch = 0;
  if (brain.identity.logline.trim()) launch += 20;
  if (brain.identity.audience.trim() || brain.identity.promise.trim()) launch += 10;
  if (brain.activeGoals.length > 0) launch += 10;
  if (hasLogo) launch += 15;
  launch += Math.min(15, aspects.size * 5);
  if (hasExport) launch += 20;
  if (brain.publishedLinks.length) launch += 10;
  const launchReadiness = clamp100(launch);

  const dimensions: ReadinessDimensions = {
    visualConsistency,
    assetCompleteness,
    promptQuality,
    exportReadiness,
    fileHygiene,
    launchReadiness,
    reusePotential,
  };

  // Overall weights launch readiness + completeness most heavily.
  const score = clamp100(
    launchReadiness * 0.3 +
      assetCompleteness * 0.2 +
      exportReadiness * 0.2 +
      visualConsistency * 0.12 +
      promptQuality * 0.08 +
      fileHygiene * 0.06 +
      reusePotential * 0.04,
  );

  return { score, dimensions };
}
