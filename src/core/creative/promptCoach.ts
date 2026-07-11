/**
 * Prompt Coach: proactive, append-only prompt suggestions from the user's own craft
 * history — high-lift tokens (Phase 1), the lineage the current prompt resembles
 * (Phase 2), and a matching recipe. Pure + deterministic; each source self-gates so it
 * stays silent (and honest) on thin data. Mirrors the house engine style.
 */
import type { CraftReport } from './craftBrain';
import { tokenizePrompt } from './craftBrain';
import type { PromptLineage } from './promptLineage';
import { tokenJaccard } from './promptLineage';
import type { CreativeRecipe } from './types';

export const MAX_TOKEN_SUGGESTIONS = 5;
export const COACH_SIM = 0.3;

export interface CoachSuggestion {
  kind: 'add-token' | 'apply-line' | 'apply-recipe';
  label: string;
  reason: string;
  /** tokens this suggestion appends (add-token: 1; apply-line: the missing spine tokens; apply-recipe: []) */
  tokens: string[];
  recipeId?: string;
}

/** Append-only apply: comma-join `tokens` onto `current`; strips trailing whitespace AND
 * commas so an in-progress "a, b, " never becomes a doubled "a, b,, c". Seeds a blank prompt. */
export function appendTokens(current: string, tokens: string[]): string {
  const added = tokens.join(', ');
  if (!added) return current;
  // Strip leading whitespace AND any trailing whitespace/commas so an in-progress
  // "a, b, " never becomes a doubled "a, b,, c" and a leading space never survives.
  const base = current.replace(/^\s+/, '').replace(/[\s,]+$/, '');
  return base ? `${base}, ${added}` : added;
}

export function coach(currentPrompt: string, craftReport: CraftReport, lineages: PromptLineage[], recipes: CreativeRecipe[]): CoachSuggestion[] {
  const currentTokens = new Set(tokenizePrompt(currentPrompt));
  const out: CoachSuggestion[] = [];

  // add-token: high-lift working tokens (already lift-ranked by analyzeCraft) not present.
  for (const w of craftReport.working) {
    if (w.kind !== 'token' || currentTokens.has(w.label)) continue;
    out.push({ kind: 'add-token', label: w.label, reason: `${w.lift}× in your kept work`, tokens: [w.label] });
    if (out.filter((s) => s.kind === 'add-token').length >= MAX_TOKEN_SUGGESTIONS) break;
  }

  // apply-line: the best-matching lineage spine with >= 1 missing token.
  let bestLine: { ln: PromptLineage; score: number; missing: string[] } | null = null;
  for (const ln of lineages) {
    if (ln.spine.length === 0) continue;
    const score = tokenJaccard(currentTokens, new Set(ln.spine));
    if (score < COACH_SIM) continue;
    const missing = ln.spine.filter((t) => !currentTokens.has(t));
    if (missing.length > 0 && (!bestLine || score > bestLine.score)) bestLine = { ln, score, missing };
  }
  if (bestLine) {
    const head = bestLine.ln.spine.slice(0, 3).join(', ');
    out.push({ kind: 'apply-line', label: head, reason: `looks like your "${head}" line`, tokens: bestLine.missing });
  }

  // apply-recipe: the best-overlapping recipe with >= 1 of its prompt tokens missing.
  // APPEND-ONLY: we borrow the recipe's missing prompt tokens (never its canvas/model/
  // negative, and never navigate) — the full recipe apply lives in the Recipes view.
  let bestRecipe: { r: CreativeRecipe; score: number; missing: string[] } | null = null;
  for (const r of recipes) {
    const rtokens = tokenizePrompt(r.promptTemplate);
    const score = tokenJaccard(currentTokens, new Set(rtokens));
    if (score < COACH_SIM) continue;
    const missing = rtokens.filter((t) => !currentTokens.has(t));
    if (missing.length > 0 && (!bestRecipe || score > bestRecipe.score)) bestRecipe = { r, score, missing };
  }
  if (bestRecipe) {
    out.push({ kind: 'apply-recipe', label: bestRecipe.r.name, reason: `from your "${bestRecipe.r.name}" recipe`, tokens: bestRecipe.missing, recipeId: bestRecipe.r.id });
  }

  return out;
}
