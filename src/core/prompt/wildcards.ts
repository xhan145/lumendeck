/**
 * Wildcards — `__name__` tokens in a prompt are replaced by a seeded random pick
 * from a named value set, so a prompt like "a __color__ car, __lighting__" resolves
 * to a concrete string that is recorded in the manifest for reproducibility.
 *
 * Pure + React-free + no I/O. Determinism comes entirely from the caller-supplied
 * RNG (seed the render seed → identical resolution).
 */

export interface WildcardSet {
  name: string;
  values: string[];
  builtin?: boolean;
}

export interface UsedWildcard {
  token: string;
  value: string;
}

export interface ExpandResult {
  /** the prompt text with all known tokens replaced */
  resolved: string;
  /** each token that was replaced, in order of first resolution */
  used: UsedWildcard[];
  /** tokens with no matching set; left untouched in `resolved` and reported here */
  unknown: string[];
}

/** Matches `__name__` tokens: word chars, dash, and space between double underscores. */
const TOKEN_RE = /__([a-zA-Z0-9 _-]+?)__/g;

/**
 * Built-in wildcard sets. Curated, small, and deterministic in order so a given
 * seed always picks the same value.
 */
export const BUILTIN_WILDCARDS: WildcardSet[] = [
  {
    name: 'color',
    builtin: true,
    values: ['crimson', 'emerald', 'sapphire', 'golden', 'violet', 'teal', 'amber', 'ivory', 'obsidian', 'coral'],
  },
  {
    name: 'lighting',
    builtin: true,
    values: ['golden hour', 'soft studio light', 'dramatic rim lighting', 'volumetric fog', 'neon glow', 'moonlight', 'backlit silhouette', 'overcast diffuse light'],
  },
  {
    name: 'mood',
    builtin: true,
    values: ['serene', 'melancholic', 'triumphant', 'mysterious', 'whimsical', 'foreboding', 'nostalgic', 'euphoric'],
  },
  {
    name: 'camera',
    builtin: true,
    values: ['wide angle', 'macro close-up', 'aerial drone shot', 'low angle', 'dutch angle', 'telephoto compression', 'fisheye', 'over-the-shoulder'],
  },
  {
    name: 'style',
    builtin: true,
    values: ['cinematic', 'watercolor', 'cyberpunk', 'art nouveau', 'baroque', 'minimalist', 'impressionist', 'vaporwave', 'photorealistic', 'ukiyo-e'],
  },
  {
    name: 'material',
    builtin: true,
    values: ['brushed steel', 'weathered oak', 'frosted glass', 'polished marble', 'woven silk', 'oxidized copper', 'carbon fiber', 'cracked leather'],
  },
];

/**
 * mulberry32 — tiny, fast, well-distributed seeded PRNG. Returns a function that
 * yields floats in [0, 1). Deterministic for a given 32-bit seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(values: T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length) % values.length];
}

/**
 * Replace every `__name__` token with a seeded pick from the matching set.
 *
 * - Unknown tokens (no matching set, or an empty set) pass through untouched and
 *   are reported in `unknown`.
 * - Nesting: a picked value may itself contain `__name__` tokens; those are
 *   resolved in a single additional pass (documented limit — deeper nesting is
 *   left literal to guarantee termination and determinism).
 */
export function expandWildcards(text: string, sets: WildcardSet[], rng: () => number): ExpandResult {
  const byName = new Map<string, WildcardSet>();
  for (const set of sets) byName.set(set.name.toLowerCase(), set);

  const used: UsedWildcard[] = [];
  const unknown: string[] = [];

  const resolveOnce = (input: string, allowNested: boolean): string =>
    input.replace(TOKEN_RE, (whole, rawName: string) => {
      const name = rawName.trim().toLowerCase();
      const set = byName.get(name);
      if (!set || set.values.length === 0) {
        if (!unknown.includes(rawName.trim())) unknown.push(rawName.trim());
        return whole; // pass through untouched
      }
      let value = pick(set.values, rng);
      // Nested resolution: resolve tokens INSIDE the picked value exactly one
      // more pass. Deeper tokens remain literal (see doc comment above).
      if (allowNested && TOKEN_RE.test(value)) {
        TOKEN_RE.lastIndex = 0;
        value = resolveOnce(value, false);
      }
      used.push({ token: name, value });
      return value;
    });

  const resolved = resolveOnce(text, true);
  return { resolved, used, unknown };
}

/** True when the text contains at least one `__name__` token. */
export function hasWildcards(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(text);
}

/** Deep-copy the built-in sets so callers never mutate the shared constant. */
export function seedBuiltinWildcards(): WildcardSet[] {
  return BUILTIN_WILDCARDS.map((s) => ({ ...s, values: [...s.values] }));
}
