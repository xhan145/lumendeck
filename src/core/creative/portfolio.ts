import type { AnalysisContext } from './context';
import { detectMissing } from './missing';
import { nextAction } from './nextAction';
import { scoreReadiness, type ReadinessDimensions } from './readiness';
import type { CreativeRecipe, NextAction, ProjectBrain, ProjectStatus } from './types';

/**
 * Cross-project portfolio analysis (Studio Overview). Pure + deterministic —
 * `now` is injected, nothing is mutated, and it never throws on blank/invalid
 * timestamps. Reuses the per-project engines (scoreReadiness / nextAction /
 * detectMissing) across all brains and aggregates. No ML — heuristic scoring only.
 */

const W_READINESS = 1;
const W_STALE = 2;
const W_BLOCKER = 15;
const STALE_CAP_DAYS = 30;
const STALE_DAYS = 14;
const VELOCITY_WEEKS = 8;
const DAY_MS = 86_400_000;

const ALL_STATUSES: ProjectStatus[] = [
  'spark',
  'in-progress',
  'polishing',
  'release-ready',
  'shipped',
  'archived',
];

const DIMENSION_LABELS: Record<keyof ReadinessDimensions, string> = {
  visualConsistency: 'Visual consistency',
  assetCompleteness: 'Asset completeness',
  promptQuality: 'Prompt quality',
  exportReadiness: 'Export readiness',
  fileHygiene: 'File hygiene',
  launchReadiness: 'Launch readiness',
  reusePotential: 'Reuse potential',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface TriageItem {
  brainId: string;
  name: string;
  status: ProjectStatus;
  readiness: number;
  attention: number;
  action: NextAction;
}

export interface StaleItem {
  brainId: string;
  name: string;
  daysSinceUpdate: number;
}

export interface PortfolioReport {
  triage: TriageItem[];
  top: TriageItem | null;
  funnel: { byStatus: Record<ProjectStatus, number>; total: number; shipped: number; shipRate: number };
  stall: { dimension: keyof ReadinessDimensions; label: string; avgScore: number; affected: number } | null;
  stale: StaleItem[];
  strengths: {
    topRecipes: { id: string; name: string; uses: number }[];
    strongestType: { type: string; shipped: number; total: number; shipRate: number } | null;
  };
  velocity: { weeks: { label: string; started: number; shipped: number }[] };
}

function isTerminal(s: ProjectStatus): boolean {
  return s === 'shipped' || s === 'archived';
}

function daysSince(iso: string, now: Date): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Earliest transition INTO 'shipped' (for velocity), or null. */
function shippedAt(brain: ProjectBrain): string | null {
  const entries = (brain.statusHistory ?? []).filter((h) => h.to === 'shipped');
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (new Date(a.at).getTime() <= new Date(b.at).getTime() ? a : b)).at;
}

/** Monday-anchored start-of-week in ms (UTC), for stable week bucketing. */
function startOfWeekMs(t: number): number {
  const d = new Date(t);
  const mondayOffset = (d.getUTCDay() + 6) % 7; // Sun=6, Mon=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - mondayOffset * DAY_MS;
}

function weekLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function analyzePortfolio(
  brains: ProjectBrain[],
  recipes: CreativeRecipe[],
  ctx: AnalysisContext,
  now: Date,
): PortfolioReport {
  const perBrain = brains.map((b) => {
    const readiness = scoreReadiness(b, ctx);
    const blockerCount = detectMissing(b, ctx).filter((m) => m.severity === 'blocker').length;
    return { b, readiness, blockerCount };
  });

  // --- Triage (non-archived, scored by attention) ---
  const triageRaw = perBrain
    .filter(({ b }) => b.status !== 'archived')
    .map(({ b, readiness, blockerCount }) => {
      const attention = isTerminal(b.status)
        ? 0
        : W_READINESS * (100 - readiness.score) +
          W_STALE * Math.min(daysSince(b.updatedAt, now), STALE_CAP_DAYS) +
          W_BLOCKER * blockerCount;
      const item: TriageItem = {
        brainId: b.id,
        name: b.name,
        status: b.status,
        readiness: readiness.score,
        attention,
        action: nextAction(b, ctx),
      };
      return { b, item };
    })
    .sort(
      (a, x) =>
        x.item.attention - a.item.attention ||
        a.item.readiness - x.item.readiness ||
        new Date(a.b.updatedAt).getTime() - new Date(x.b.updatedAt).getTime(),
    );
  const triage = triageRaw.map((r) => r.item);
  const top = triage.length > 0 && triage[0].attention > 0 ? triage[0] : null;

  // --- Funnel ---
  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<ProjectStatus, number>;
  for (const b of brains) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  const total = brains.length;
  const shipped = byStatus.shipped;
  const shipRate = total > 0 ? shipped / total : 0;

  // --- Stall (weakest average readiness dimension across unshipped projects) ---
  const unshipped = perBrain.filter(({ b }) => !isTerminal(b.status));
  let stall: PortfolioReport['stall'] = null;
  if (unshipped.length > 0) {
    const keys = Object.keys(DIMENSION_LABELS) as (keyof ReadinessDimensions)[];
    let best: { dimension: keyof ReadinessDimensions; avg: number } | null = null;
    for (const k of keys) {
      const avg = unshipped.reduce((sum, { readiness }) => sum + readiness.dimensions[k], 0) / unshipped.length;
      if (!best || avg < best.avg) best = { dimension: k, avg };
    }
    stall = {
      dimension: best!.dimension,
      label: DIMENSION_LABELS[best!.dimension],
      avgScore: Math.round(best!.avg),
      affected: unshipped.length,
    };
  }

  // --- Stale (aged, unshipped) ---
  const stale: StaleItem[] = perBrain
    .filter(({ b }) => !isTerminal(b.status))
    .map(({ b }) => ({ brainId: b.id, name: b.name, daysSinceUpdate: daysSince(b.updatedAt, now) }))
    .filter((s) => s.daysSinceUpdate >= STALE_DAYS)
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

  // --- Strengths (top recipes + strongest type) ---
  const useCount = new Map<string, number>();
  for (const b of brains) for (const rid of b.recipes ?? []) useCount.set(rid, (useCount.get(rid) ?? 0) + 1);
  const nameById = new Map(recipes.map((r) => [r.id, r.name]));
  const topRecipes = [...useCount.entries()]
    .filter(([id]) => nameById.has(id))
    .map(([id, uses]) => ({ id, name: nameById.get(id)!, uses }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
    .slice(0, 5);

  const byType = new Map<string, { shipped: number; total: number }>();
  for (const b of brains) {
    const t = byType.get(b.type) ?? { shipped: 0, total: 0 };
    t.total += 1;
    if (b.status === 'shipped') t.shipped += 1;
    byType.set(b.type, t);
  }
  let strongestType: PortfolioReport['strengths']['strongestType'] = null;
  for (const [type, { shipped: s, total: t }] of byType) {
    if (t < 2) continue;
    const rate = s / t;
    if (!strongestType || rate > strongestType.shipRate) {
      strongestType = { type, shipped: s, total: t, shipRate: rate };
    }
  }

  // --- Velocity (last VELOCITY_WEEKS weeks) ---
  const weekStartNow = startOfWeekMs(now.getTime());
  const buckets = Array.from({ length: VELOCITY_WEEKS }, (_, i) => {
    const startMs = weekStartNow - (VELOCITY_WEEKS - 1 - i) * 7 * DAY_MS;
    return { label: weekLabel(startMs), started: 0, shipped: 0, startMs };
  });
  const bucketFor = (ms: number) => {
    if (!Number.isFinite(ms)) return null;
    const ws = startOfWeekMs(ms);
    return buckets.find((bk) => bk.startMs === ws) ?? null;
  };
  for (const b of brains) {
    const created = bucketFor(new Date(b.createdAt).getTime());
    if (created) created.started += 1;
    const sa = shippedAt(b);
    if (sa) {
      const shippedBucket = bucketFor(new Date(sa).getTime());
      if (shippedBucket) shippedBucket.shipped += 1;
    }
  }
  const weeks = buckets.map(({ label, started, shipped: s }) => ({ label, started, shipped: s }));

  return {
    triage,
    top,
    funnel: { byStatus, total, shipped, shipRate },
    stall,
    stale,
    strengths: { topRecipes, strongestType },
    velocity: { weeks },
  };
}
