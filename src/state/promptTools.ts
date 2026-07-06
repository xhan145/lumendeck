/**
 * Persisted "Prompt & Creative Tooling" slice: prompt presets, wildcard sets, and
 * prompt history. This module owns the slice SHAPE + hydration/merge logic so the
 * store stays lean and existing persisted state (which predates this feature)
 * loads gracefully — a missing or partial slice is merged with seeded defaults.
 */
import { seedStarterPresets, type PromptPreset } from '../core/prompt/presets';
import { seedBuiltinWildcards, type WildcardSet } from '../core/prompt/wildcards';
import type { PromptHistoryEntry } from '../core/prompt/history';

export interface PromptToolsState {
  presets: PromptPreset[];
  wildcardSets: WildcardSet[];
  history: PromptHistoryEntry[];
}

/** Fresh defaults for a first run: seeded builtins, no history. */
export function defaultPromptTools(): PromptToolsState {
  return {
    presets: seedStarterPresets(),
    wildcardSets: seedBuiltinWildcards(),
    history: [],
  };
}

/**
 * Merge persisted prompt-tools state with defaults so upgrades are safe:
 * - Missing slice → full defaults.
 * - Persisted presets/wildcards are kept, but any NEW builtins shipped since the
 *   save are re-added (matched by id/name) so users gain new starter content.
 * - History is passed through (capped elsewhere on write).
 */
export function hydratePromptTools(persisted: PromptToolsState | undefined): PromptToolsState {
  const defaults = defaultPromptTools();
  if (!persisted) return defaults;

  const presets = Array.isArray(persisted.presets) ? [...persisted.presets] : [];
  const presetIds = new Set(presets.map((p) => p.id));
  for (const builtin of defaults.presets) {
    if (!presetIds.has(builtin.id)) presets.push(builtin);
  }

  const wildcardSets = Array.isArray(persisted.wildcardSets) ? [...persisted.wildcardSets] : [];
  const setNames = new Set(wildcardSets.map((s) => s.name.toLowerCase()));
  for (const builtin of defaults.wildcardSets) {
    if (!setNames.has(builtin.name.toLowerCase())) wildcardSets.push(builtin);
  }

  const history = Array.isArray(persisted.history) ? persisted.history : [];

  return { presets, wildcardSets, history };
}
