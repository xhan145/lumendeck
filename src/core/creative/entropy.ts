/**
 * Entropy scan. Surfaces disorder across projects + the gallery: duplicates,
 * orphans, broken links, stale prompts, unused/unlabeled renders, projects with
 * no exports, and campaigns missing required variants. Each finding ships with
 * the recommended actions the UI offers.
 */
import type { AnalysisContext } from './context';
import { indexRenders } from './context';
import type { EntropyItem, ProjectBrain } from './types';
import { creativeId } from './brain';

/** Prompts untouched for this long are considered stale. */
export const STALE_PROMPT_DAYS = 30;

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / 86_400_000;
}

/**
 * Scan every project + the shared gallery. `now` anchors staleness so results
 * are deterministic in tests.
 */
export function scanEntropy(brains: ProjectBrain[], ctx: AnalysisContext, now: Date): EntropyItem[] {
  const items: EntropyItem[] = [];
  const idx = indexRenders(ctx);
  const nowIso = now.toISOString();
  const mk = (partial: Omit<EntropyItem, 'id'>): EntropyItem => ({ id: creativeId('ent'), ...partial });

  // ---- duplicate renders (gallery-global): same signature seen more than once
  const bySignature = new Map<string, string[]>();
  for (const r of ctx.renders) {
    if (!r.signature) continue;
    const list = bySignature.get(r.signature) ?? [];
    list.push(r.id);
    bySignature.set(r.signature, list);
  }
  for (const [sig, ids] of bySignature) {
    if (ids.length > 1) {
      items.push(mk({
        kind: 'duplicate-render',
        severity: 'medium',
        label: `${ids.length} duplicate renders`,
        detail: `${ids.length} renders share identical prompt + seed + size (${sig.slice(0, 40)}…). Keep one, archive the rest.`,
        ref: ids[1],
        actions: ['merge', 'archive', 'delete'],
      }));
    }
  }

  // ---- unlabeled + unused renders (gallery-global)
  for (const r of ctx.renders) {
    if (!r.labeled) {
      items.push(mk({
        kind: 'unlabeled-render',
        severity: 'low',
        label: 'Unlabeled render',
        detail: 'This render has no collection or tags — it will be hard to find later.',
        ref: r.id,
        actions: ['retag', 'archive'],
      }));
    }
    if (!r.linkedToProject) {
      items.push(mk({
        kind: 'unused-render',
        severity: 'low',
        label: 'Unused render',
        detail: 'This render is not linked to any project. Promote it to a recipe or archive it.',
        ref: r.id,
        actions: ['promote-to-recipe', 'archive', 'delete'],
      }));
    }
  }

  // ---- per-project findings
  for (const brain of brains) {
    if (brain.status === 'archived') continue;

    // orphaned render links: brain references a render id that no longer exists
    for (const id of brain.renders) {
      if (!idx.has(id)) {
        items.push(mk({
          kind: 'orphaned-render-link',
          severity: 'high',
          label: 'Orphaned render link',
          detail: `${brain.name} references a render (${id.slice(0, 10)}…) that no longer exists in the gallery.`,
          projectId: brain.id,
          ref: id,
          actions: ['repair', 'delete'],
        }));
      }
    }

    // broken assets + orphaned external assets
    for (const a of brain.assets) {
      if (a.archived) continue;
      const galleryGone = a.galleryId != null && !idx.has(a.galleryId);
      if (a.status === 'broken' || galleryGone) {
        items.push(mk({
          kind: 'broken-asset',
          severity: 'high',
          label: `Broken asset: ${a.label}`,
          detail: galleryGone ? 'Linked render was deleted from the gallery.' : 'External file path is marked broken.',
          projectId: brain.id,
          ref: a.id,
          actions: ['repair', 'regenerate', 'delete'],
        }));
      } else if (!a.galleryId && !a.path) {
        items.push(mk({
          kind: 'orphaned-asset',
          severity: 'medium',
          label: `Orphaned asset: ${a.label}`,
          detail: 'Asset has neither a linked render nor a file path — it points at nothing.',
          projectId: brain.id,
          ref: a.id,
          actions: ['repair', 'delete'],
        }));
      }
    }

    // stale prompts: added long ago, never produced output, still hanging around
    for (const p of brain.prompts) {
      const age = daysBetween(p.addedAt || nowIso, nowIso);
      if (!p.lastProducedAt && age >= STALE_PROMPT_DAYS) {
        items.push(mk({
          kind: 'stale-prompt',
          severity: 'low',
          label: 'Stale prompt',
          detail: `"${p.text.slice(0, 40)}" has sat unused for ${Math.round(age)} days.`,
          projectId: brain.id,
          ref: p.id,
          actions: ['regenerate', 'promote-to-recipe', 'delete'],
        }));
      }
    }

    // projects with no exports (but with real work in them)
    const hasWork = brain.renders.length > 0 || brain.assets.length > 0;
    if (hasWork && brain.exports.length === 0) {
      items.push(mk({
        kind: 'project-no-exports',
        severity: 'medium',
        label: 'No exports',
        detail: `${brain.name} has assets/renders but has never shipped an export.`,
        projectId: brain.id,
        actions: ['regenerate'],
      }));
    }

    // campaigns missing required aspect variants
    if (brain.type === 'campaign') {
      const present = new Set(brain.renders.map((id) => idx.get(id)?.aspect).filter(Boolean));
      const missing = (['16:9', '1:1', '9:16'] as const).filter((a) => !present.has(a));
      if (missing.length > 0) {
        items.push(mk({
          kind: 'campaign-missing-variants',
          severity: 'medium',
          label: 'Campaign missing variants',
          detail: `Campaign is missing ${missing.join(', ')} variant${missing.length > 1 ? 's' : ''}.`,
          projectId: brain.id,
          actions: ['regenerate'],
        }));
      }
    }
  }

  const rank: Record<EntropyItem['severity'], number> = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function summarizeEntropy(items: EntropyItem[]): { high: number; medium: number; low: number; total: number } {
  const high = items.filter((i) => i.severity === 'high').length;
  const medium = items.filter((i) => i.severity === 'medium').length;
  return { high, medium, low: items.length - high - medium, total: items.length };
}
