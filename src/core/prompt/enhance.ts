/**
 * Prompt enhancer — a pure, rule-based heuristic that appends quality/detail
 * tags (chosen by detected subject), proposes standard negatives, normalizes
 * weight syntax, and de-dups. Idempotent: running it on its own output adds
 * nothing new.
 *
 * A `PromptAssistant` interface abstracts the enhancement so a future cloud LLM
 * can be dropped in behind the same seam. `HeuristicAssistant` is the default and
 * only implemented impl here; `CloudAssistant` is a documented TYPE-ONLY seam.
 */

export type PromptSubject = 'portrait' | 'landscape' | 'generic';

export interface EnhanceOptions {
  /** override subject detection */
  subject?: PromptSubject;
  /** when false, no negatives are proposed (default true) */
  proposeNegatives?: boolean;
}

export interface EnhanceResult {
  /** enhanced positive prompt */
  positive: string;
  /** negatives to ADD to the existing negative prompt (dedup handled by caller/UI) */
  negativeAdditions: string[];
  /** human-readable notes describing what changed */
  notes: string[];
}

/** Quality tags added for every subject. */
const GENERIC_TAGS = ['sharp focus', 'highly detailed'];
const PORTRAIT_TAGS = ['detailed skin texture', 'catchlight in eyes', 'natural lighting'];
const LANDSCAPE_TAGS = ['atmospheric depth', 'volumetric light', 'expansive vista'];

const STANDARD_NEGATIVES = ['blurry', 'lowres', 'bad anatomy', 'extra fingers', 'watermark', 'jpeg artifacts'];

const PORTRAIT_HINTS = ['portrait', 'face', 'woman', 'man', 'person', 'girl', 'boy', 'headshot', 'selfie', 'eyes', 'model'];
const LANDSCAPE_HINTS = ['landscape', 'mountain', 'forest', 'ocean', 'sunset', 'valley', 'cityscape', 'vista', 'field', 'sky', 'river', 'desert'];

/** Detect the dominant subject from the prompt text. */
export function detectSubject(text: string): PromptSubject {
  const t = text.toLowerCase();
  const portrait = PORTRAIT_HINTS.some((h) => t.includes(h));
  const landscape = LANDSCAPE_HINTS.some((h) => t.includes(h));
  if (portrait && !landscape) return 'portrait';
  if (landscape && !portrait) return 'landscape';
  return 'generic';
}

/** Split a prompt into trimmed, non-empty, comma-separated tags. */
function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Normalize weight syntax: collapse extra spaces inside `(x : 1.20)` to
 * `(x:1.2)` (trim trailing zeros on the weight). Leaves plain tags untouched.
 */
export function normalizeWeight(tag: string): string {
  const m = tag.match(/^\((.+?)\s*:\s*(-?\d*\.?\d+)\)$/);
  if (!m) return tag;
  const label = m[1].trim();
  const weight = String(parseFloat(m[2])); // "1.20" -> "1.2", "1.0" -> "1"
  return `(${label}:${weight})`;
}

/** Case-insensitive tag equality after weight normalization. */
function tagKey(tag: string): string {
  return normalizeWeight(tag).toLowerCase();
}

/**
 * Enhance a prompt. Pure and idempotent. Returns the enhanced positive text, the
 * negatives to add, and notes. De-dups existing tags and normalizes weights.
 */
export function enhancePrompt(text: string, opts: EnhanceOptions = {}): EnhanceResult {
  const subject = opts.subject ?? detectSubject(text);
  const proposeNegatives = opts.proposeNegatives !== false;
  const notes: string[] = [];

  // Existing tags, normalized + de-duplicated (preserving first occurrence).
  const existing = splitTags(text).map(normalizeWeight);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const tag of existing) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      notes.push(`Removed duplicate tag "${tag}".`);
      continue;
    }
    seen.add(key);
    deduped.push(tag);
  }

  // Candidate quality tags for the detected subject.
  const candidates =
    subject === 'portrait'
      ? [...PORTRAIT_TAGS, ...GENERIC_TAGS]
      : subject === 'landscape'
        ? [...LANDSCAPE_TAGS, ...GENERIC_TAGS]
        : [...GENERIC_TAGS];

  const added: string[] = [];
  for (const tag of candidates) {
    if (!seen.has(tagKey(tag))) {
      seen.add(tagKey(tag));
      deduped.push(tag);
      added.push(tag);
    }
  }
  if (added.length > 0) notes.push(`Added ${subject} quality tags: ${added.join(', ')}.`);
  else notes.push('Prompt already has the recommended quality tags.');

  const negativeAdditions = proposeNegatives ? [...STANDARD_NEGATIVES] : [];

  return {
    positive: deduped.join(', '),
    negativeAdditions,
    notes,
  };
}

/**
 * Merge proposed negatives into an existing negative prompt without duplicating.
 * Shared by UI accept + store; pure.
 */
export function mergeNegatives(existing: string, additions: string[]): string {
  const have = new Set(splitTags(existing).map((t) => t.toLowerCase()));
  const merged = splitTags(existing);
  for (const add of additions) {
    if (!have.has(add.toLowerCase())) {
      have.add(add.toLowerCase());
      merged.push(add);
    }
  }
  return merged.join(', ');
}

/**
 * Abstraction over prompt enhancement. The heuristic runs synchronously; the
 * interface is async so a cloud impl can await a network round-trip.
 */
export interface PromptAssistant {
  readonly id: string;
  readonly label: string;
  /** true when the assistant is usable in the current environment */
  readonly available: boolean;
  enhance(text: string, opts?: EnhanceOptions): Promise<EnhanceResult>;
}

/** Default assistant: the local rule-based enhancer. Always available. */
export class HeuristicAssistant implements PromptAssistant {
  readonly id = 'heuristic';
  readonly label = 'Built-in enhancer';
  readonly available = true;
  async enhance(text: string, opts?: EnhanceOptions): Promise<EnhanceResult> {
    return enhancePrompt(text, opts);
  }
}

/**
 * TYPE-ONLY seam for a future cloud LLM assistant. NOT implemented here.
 *
 * When a provider key exists, a concrete impl would POST the prompt to the bridge
 * `/cloud/*` route (Codex's cloud-providers work) and map the response into an
 * EnhanceResult. It is declared as a type so the UI + store can reference the
 * seam and light up a "Use AI model" affordance without shipping the network code.
 *
 * Reference shape a concrete impl must satisfy:
 *
 *   class RealCloudAssistant implements CloudAssistant {
 *     readonly id = 'cloud';
 *     readonly label = 'Cloud model';
 *     readonly available = false; // flips true once a key is configured
 *     readonly endpoint = '/cloud/enhance';
 *     async enhance(text, opts) { ...fetch(this.endpoint)... }
 *   }
 */
export interface CloudAssistant extends PromptAssistant {
  /** bridge route the concrete impl will POST to, e.g. '/cloud/enhance' */
  readonly endpoint: string;
}

/** The default assistant instance used by the store/UI. */
export const defaultAssistant: PromptAssistant = new HeuristicAssistant();
