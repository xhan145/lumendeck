/**
 * Prompt Lab lineage engine: groups renders into time-ordered "prompt lines" by prompt
 * token similarity (greedy by time, Jaccard >= LINEAGE_SIM), and diffs prompts/settings
 * for the compare view. Pure + deterministic (stable sort by time then id); reuses
 * craftBrain's tokenizePrompt. No store/ML. Mirrors the house engine style.
 */
import type { RenderInfo } from './context';
import { tokenizePrompt } from './craftBrain';

export const LINEAGE_SIM = 0.5;
export const MIN_LINEAGE = 2;
export const MAX_LINEAGES = 40;

export interface LineageStep {
  renderId: string;
  added: string[];
  removed: string[];
}
export interface PromptLineage {
  id: string;
  renderIds: string[];
  spine: string[];
  steps: LineageStep[];
  size: number;
}
export interface PromptDiff {
  added: string[];
  removed: string[];
  kept: string[];
}
export interface SettingDelta {
  key: string;
  from: string;
  to: string;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function diffPrompts(prev: string[], next: string[]): PromptDiff {
  const p = new Set(prev);
  const n = new Set(next);
  return {
    added: [...n].filter((t) => !p.has(t)),
    removed: [...p].filter((t) => !n.has(t)),
    kept: [...n].filter((t) => p.has(t)),
  };
}

function settingStr(rr: RenderInfo, key: string): string {
  switch (key) {
    case 'model': return rr.modelFamily && rr.modelFamily.trim() ? rr.modelFamily.trim() : '—';
    case 'sampler': return rr.sampler && rr.sampler.trim() ? rr.sampler.trim() : '—';
    case 'cfg': return typeof rr.cfg === 'number' && rr.cfg > 0 ? `${rr.cfg}` : '—';
    case 'steps': return typeof rr.steps === 'number' && rr.steps > 0 ? `${rr.steps}` : '—';
    case 'aspect': return rr.aspect ?? '—';
    default: return '—';
  }
}

export function diffSettings(a: RenderInfo, b: RenderInfo): SettingDelta[] {
  const out: SettingDelta[] = [];
  for (const key of ['model', 'sampler', 'cfg', 'steps', 'aspect']) {
    const from = settingStr(a, key);
    const to = settingStr(b, key);
    if (from !== to) out.push({ key, from, to });
  }
  return out;
}

export function buildLineages(renders: RenderInfo[]): PromptLineage[] {
  const items = renders
    .filter((rr) => !rr.fallback)
    .map((rr) => ({ r: rr, tokens: new Set(tokenizePrompt(rr.prompt)) }))
    .filter((x) => x.tokens.size > 0)
    .sort((x, y) => {
      const tx = Date.parse(x.r.createdAt);
      const ty = Date.parse(y.r.createdAt);
      const nx = Number.isFinite(tx) ? tx : 0;
      const ny = Number.isFinite(ty) ? ty : 0;
      return nx - ny || x.r.id.localeCompare(y.r.id);
    });

  type Member = { r: RenderInfo; tokens: Set<string> };
  const groups: Member[][] = [];
  for (const it of items) {
    let best: Member[] | null = null;
    let bestScore = 0;
    for (const g of groups) {
      let score = 0;
      for (const m of g) score = Math.max(score, jaccard(it.tokens, m.tokens));
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    if (best && bestScore >= LINEAGE_SIM) best.push(it);
    else groups.push([it]);
  }

  return groups
    .filter((g) => g.length >= MIN_LINEAGE)
    .map((g) => {
      const renderIds = g.map((m) => m.r.id);
      let spine: Set<string> | null = null;
      for (const m of g) {
        if (spine === null) spine = new Set(m.tokens);
        else for (const t of [...spine]) if (!m.tokens.has(t)) spine.delete(t);
      }
      const steps: LineageStep[] = g.map((m, i) => {
        if (i === 0) return { renderId: m.r.id, added: [], removed: [] };
        const d = diffPrompts([...g[i - 1].tokens], [...m.tokens]);
        return { renderId: m.r.id, added: d.added, removed: d.removed };
      });
      return { id: renderIds[0], renderIds, spine: spine ? [...spine].sort() : [], steps, size: renderIds.length };
    })
    .sort((a, b) => b.size - a.size || b.id.localeCompare(a.id));
}
