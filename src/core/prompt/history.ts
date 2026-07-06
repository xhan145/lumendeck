/**
 * Prompt history — a capped, reverse-chronological log of rendered prompts with
 * favorites. Pure + React-free. The store records one entry per render and
 * persists the list; the UI searches, stars, and reloads entries.
 */

export interface PromptHistoryEntry {
  id: string;
  positive: string;
  negative: string;
  /** the wildcard-resolved positive text actually sent to the backend (if any) */
  resolved?: string;
  seed: number;
  modelId?: string;
  /** ISO timestamp */
  at: string;
  favorite: boolean;
}

export const HISTORY_CAP = 500;

/** Two entries are "consecutive identical" if their prompt text + seed match. */
function sameContent(a: PromptHistoryEntry, b: PromptHistoryEntry): boolean {
  return a.positive === b.positive
    && a.negative === b.negative
    && (a.resolved ?? '') === (b.resolved ?? '')
    && a.seed === b.seed;
}

/**
 * Prepend `entry` (newest first). Dedups against the current head (skips writing
 * a consecutive identical prompt). Trims to `cap` but NEVER drops favorites: only
 * non-favorite entries beyond the cap are removed.
 */
export function record(list: PromptHistoryEntry[], entry: PromptHistoryEntry, cap = HISTORY_CAP): PromptHistoryEntry[] {
  if (list.length > 0 && sameContent(list[0], entry)) {
    // Consecutive identical prompt — keep the existing head, but let a new favorite flag win.
    if (entry.favorite && !list[0].favorite) {
      return [{ ...list[0], favorite: true }, ...list.slice(1)];
    }
    return list;
  }

  const next = [entry, ...list];
  if (next.length <= cap) return next;

  // Trim: keep every favorite, keep the newest non-favorites up to the remaining budget.
  const favorites = next.filter((e) => e.favorite);
  const nonFavorites = next.filter((e) => !e.favorite);
  const budget = Math.max(0, cap - favorites.length);
  const keptNonFavorites = new Set(nonFavorites.slice(0, budget));
  return next.filter((e) => e.favorite || keptNonFavorites.has(e));
}

/** Toggle the favorite flag on the entry with the given id. */
export function toggleFavorite(list: PromptHistoryEntry[], id: string): PromptHistoryEntry[] {
  return list.map((e) => (e.id === id ? { ...e, favorite: !e.favorite } : e));
}

export interface SearchOptions {
  /** when true, matching favorites are listed before matching non-favorites */
  favoritesFirst?: boolean;
  /** when true, restrict results to favorites */
  onlyFavorites?: boolean;
}

/**
 * Substring search over positive + negative + resolved text (case-insensitive).
 * An empty query returns the whole list (subject to onlyFavorites). Preserves
 * reverse-chronological order within each group.
 */
export function search(list: PromptHistoryEntry[], query: string, opts: SearchOptions = {}): PromptHistoryEntry[] {
  const q = query.trim().toLowerCase();
  let matched = list.filter((e) => {
    if (opts.onlyFavorites && !e.favorite) return false;
    if (!q) return true;
    return (
      e.positive.toLowerCase().includes(q)
      || e.negative.toLowerCase().includes(q)
      || (e.resolved ?? '').toLowerCase().includes(q)
    );
  });
  if (opts.favoritesFirst) {
    matched = [...matched.filter((e) => e.favorite), ...matched.filter((e) => !e.favorite)];
  }
  return matched;
}
