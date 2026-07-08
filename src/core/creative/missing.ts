/**
 * Missing-piece detector. Deterministic scan of a project brain (+ its renders)
 * that surfaces the concrete gaps between "has stuff" and "release-ready".
 *
 * Covers 15 gap kinds (>= the 10 the spec requires): identity, goals, logo,
 * three promo aspects, short/long/social/readme copy, release zip, export
 * folder, broken asset paths, renders without prompt lineage, prompts without
 * outputs.
 */
import type { AnalysisContext } from './context';
import { indexRenders } from './context';
import type { MissingItem, ProjectBrain } from './types';

function hasAspectRender(brain: ProjectBrain, ctx: AnalysisContext, aspect: '16:9' | '1:1' | '9:16'): boolean {
  const idx = indexRenders(ctx);
  return brain.renders.some((id) => idx.get(id)?.aspect === aspect)
    || brain.assets.some((a) => a.kind === 'promo' && !a.archived && a.galleryId != null && idx.get(a.galleryId)?.aspect === aspect);
}

export function detectMissing(brain: ProjectBrain, ctx: AnalysisContext): MissingItem[] {
  const items: MissingItem[] = [];
  const idx = indexRenders(ctx);
  const push = (m: MissingItem) => items.push(m);

  // ---- identity & goals
  const hasIdentity = brain.identity.logline.trim().length > 0;
  if (!hasIdentity) {
    push({ kind: 'no-identity', severity: 'blocker', label: 'No project brief', detail: 'Core identity (logline) is empty — the project has no stated purpose.' });
  }
  if (brain.activeGoals.length === 0) {
    push({ kind: 'no-goals', severity: 'warn', label: 'No active goals', detail: 'No goals are set, so readiness and next actions have nothing to aim at.' });
  }

  // ---- logo
  const hasLogo = brain.assets.some((a) => a.kind === 'logo' && !a.archived && a.status === 'ok');
  if (!hasLogo) {
    push({ kind: 'no-logo', severity: 'blocker', label: 'No logo', detail: 'No usable logo asset is linked. Every release pack expects one.' });
  }

  // ---- promo variants (three aspects)
  if (!hasAspectRender(brain, ctx, '16:9')) {
    push({ kind: 'no-promo-16x9', severity: 'warn', label: 'No 16:9 promo', detail: 'Missing a landscape hero image (headers, video thumbnails, itch banners).' });
  }
  if (!hasAspectRender(brain, ctx, '1:1')) {
    push({ kind: 'no-promo-1x1', severity: 'warn', label: 'No 1:1 promo', detail: 'Missing a square image (avatars, app icons, feed posts).' });
  }
  if (!hasAspectRender(brain, ctx, '9:16')) {
    push({ kind: 'no-promo-9x16', severity: 'warn', label: 'No 9:16 promo', detail: 'Missing a vertical image (stories, reels, mobile splash).' });
  }

  // ---- copy
  if (!brain.copy.shortDescription.trim()) {
    push({ kind: 'no-short-description', severity: 'warn', label: 'No short description', detail: 'A one-liner for store listings and social bios is missing.' });
  }
  if (!brain.copy.longDescription.trim()) {
    push({ kind: 'no-long-description', severity: 'warn', label: 'No long description', detail: 'A full description for the landing page / release notes is missing.' });
  }
  if (brain.copy.socialCaptions.length === 0) {
    push({ kind: 'no-social-captions', severity: 'warn', label: 'No social captions', detail: 'No launch captions are written for X / Instagram.' });
  }
  if (!brain.copy.readmeSection.trim()) {
    push({ kind: 'no-readme-copy', severity: 'warn', label: 'No README copy', detail: 'No README section drafted for the repo or download page.' });
  }

  // ---- exports
  const hasZip = brain.exports.some((e) => e.kind === 'zip' || e.kind === 'release-pack');
  if (!hasZip) {
    push({ kind: 'no-release-zip', severity: 'warn', label: 'No release ZIP', detail: 'No packaged download has been built yet.' });
  }
  const hasFolder = brain.exports.some((e) => e.kind === 'release-pack' || e.kind === 'folder');
  if (!hasFolder) {
    push({ kind: 'no-export-folder', severity: 'warn', label: 'No final export folder', detail: 'No structured release folder assembled — run Build Release Pack.' });
  }

  // ---- integrity: broken asset paths (item-specific)
  for (const a of brain.assets) {
    if (a.archived) continue;
    const broken = a.status === 'broken' || (a.galleryId != null && !idx.has(a.galleryId));
    if (broken) {
      push({ kind: 'broken-asset-path', severity: 'blocker', label: `Broken asset: ${a.label}`, detail: a.galleryId ? 'Linked render no longer exists in the gallery.' : 'External file path is marked broken.', ref: a.id });
    }
  }

  // ---- integrity: renders without prompt lineage (item-specific)
  for (const id of brain.renders) {
    const r = idx.get(id);
    if (!r) continue; // absence handled by orphaned-render-link in entropy scan
    if (!r.prompt.trim()) {
      push({ kind: 'render-missing-lineage', severity: 'warn', label: 'Render without prompt lineage', detail: 'A linked render has no recorded prompt, so it cannot be reproduced or promoted to a recipe.', ref: id });
    }
  }

  // ---- integrity: prompts without outputs (item-specific)
  const producedPrompts = new Set(
    brain.renders.map((id) => idx.get(id)?.prompt.trim().toLowerCase()).filter(Boolean) as string[],
  );
  for (const p of brain.prompts) {
    const text = p.text.trim().toLowerCase();
    if (text && !producedPrompts.has(text) && !p.lastProducedAt) {
      push({ kind: 'prompt-without-output', severity: 'warn', label: 'Prompt without output', detail: `"${p.text.slice(0, 48)}" has never produced a linked render.`, ref: p.id });
    }
  }

  return items;
}

/** Count blockers vs warnings for badge/summary rendering. */
export function summarizeMissing(items: MissingItem[]): { blockers: number; warns: number; total: number } {
  const blockers = items.filter((i) => i.severity === 'blocker').length;
  return { blockers, warns: items.length - blockers, total: items.length };
}
