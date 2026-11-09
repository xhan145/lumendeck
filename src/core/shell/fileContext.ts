import type { FileEntry } from '../../bridge/files';

export type FileContextMode = 'off' | 'links' | 'focus';
export type ContextEvidenceKind = 'same-basename' | 'shared-token' |
  'same-extension' | 'same-kind' | 'modified-nearby';

export interface ContextEvidence {
  kind: ContextEvidenceKind;
  label: string;
  weight: number;
}

export interface FileContextRelation {
  entry: FileEntry;
  score: number;
  evidence: ContextEvidence[];
}

export interface FileContextLens {
  anchor: FileEntry;
  relations: FileContextRelation[];
  scoreByPath: ReadonlyMap<string, number>;
  candidates: number;
  threshold: number;
}

export const CONTEXT_DEFAULT_THRESHOLD = 35;
export const CONTEXT_MAX_LINKS = 18;
const CONTEXT_MIN = 25;
const CONTEXT_MAX = 85;
const STOP_WORDS = new Set([
  'file', 'files', 'folder', 'image', 'images', 'photo', 'photos',
  'picture', 'document', 'documents', 'new', 'final', 'copy',
  'draft', 'version', 'export', 'original', 'untitled', 'backup',
]);

export function clampContextThreshold(value: number): number {
  return Number.isFinite(value) ? Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, Math.round(value)))
    : CONTEXT_DEFAULT_THRESHOLD;
}

function baseName(entry: FileEntry): string {
  const ext = entry.extension.toLowerCase();
  const name = entry.name.toLocaleLowerCase();
  if (entry.isDirectory || !ext) return name;
  const suffix = '.' + ext;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function words(entry: FileEntry): Set<string> {
  return new Set((baseName(entry).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)));
}

/** Evidence from listed metadata only. No file contents, embeddings or disk scans. */
export function compareFileContext(anchor: FileEntry, candidate: FileEntry): FileContextRelation | null {
  if (anchor.path === candidate.path) return null;
  const evidence: ContextEvidence[] = [];
  const nameA = baseName(anchor);
  const nameB = baseName(candidate);
  if (nameA.length >= 3 && nameA === nameB) {
    evidence.push({ kind: 'same-basename', label: 'Same filename stem', weight: 70 });
  } else {
    const aa = words(anchor);
    const bb = words(candidate);
    const shared = [...aa].filter((word) => bb.has(word)).sort((a, b) => a.localeCompare(b));
    if (shared.length) {
      evidence.push({
        kind: 'shared-token',
        label: 'Shared filename ' + (shared.length === 1 ? 'word' : 'words') + ': ' +
          shared.slice(0, 2).join(', '),
        weight: shared.length >= 2 ? 48 : 36,
      });
    }
  }
  if (anchor.extension && candidate.extension &&
    anchor.extension.toLowerCase() === candidate.extension.toLowerCase() &&
    !anchor.isDirectory && !candidate.isDirectory) {
    evidence.push({
      kind: 'same-extension', label: 'Both .' + anchor.extension.toLowerCase(), weight: 28,
    });
  } else if (anchor.kind === candidate.kind && anchor.kind !== 'file') {
    evidence.push({
      kind: 'same-kind', label: 'Both ' + anchor.kind + ' items', weight: 12,
    });
  }
  if (anchor.modifiedMs !== null && candidate.modifiedMs !== null &&
    Number.isFinite(anchor.modifiedMs) && Number.isFinite(candidate.modifiedMs) &&
    anchor.modifiedMs >= 0 && candidate.modifiedMs >= 0) {
    const hours = Math.abs(anchor.modifiedMs - candidate.modifiedMs) / 3600000;
    if (hours <= 24) {
      evidence.push({ kind: 'modified-nearby', label: 'Modified within 24 hours', weight: 12 });
    } else if (hours <= 24 * 7) {
      evidence.push({ kind: 'modified-nearby', label: 'Modified within 7 days', weight: 5 });
    }
  }
  const score = Math.min(100, evidence.reduce((sum, item) => sum + item.weight, 0));
  return score ? { entry: candidate, score, evidence } : null;
}

/**
 * Builds a small explainable local context lens over entries already loaded
 * and represented as stars. All links are metadata similarities, not inferred
 * dependencies, content semantics, duplicates or confirmed project membership.
 */
export function buildFileContextLens(
  entries: readonly FileEntry[],
  selectedPath: string | null,
  threshold = CONTEXT_DEFAULT_THRESHOLD,
  maxLinks = CONTEXT_MAX_LINKS,
): FileContextLens | null {
  if (!selectedPath) return null;
  const anchor = entries.find((entry) => entry.path === selectedPath);
  if (!anchor) return null;
  const limit = Math.max(0, Math.min(CONTEXT_MAX_LINKS, Math.floor(maxLinks)));
  const cutoff = clampContextThreshold(threshold);
  const candidates = entries.length - 1;
  const matches = entries.flatMap((entry) => {
    const relation = compareFileContext(anchor, entry);
    return relation && relation.score >= cutoff ? [relation] : [];
  }).sort((a, b) => b.score - a.score ||
    a.entry.path.localeCompare(b.entry.path, undefined, { numeric: true }));
  const relations = matches.slice(0, limit);
  return {
    anchor, relations, candidates, threshold: cutoff,
    scoreByPath: new Map(relations.map((item) => [item.entry.path, item.score])),
  };
}

export interface ContextPoint { x: number; y: number; z: number; }

/** Fifth coordinate (evidence score) projected over existing 3D+time geometry. */
export function projectFileContext(
  point: ContextPoint,
  anchor: ContextPoint,
  score: number,
  mode: FileContextMode,
  isAnchor: boolean,
): ContextPoint {
  if (mode === 'off' || isAnchor) return point;
  const strength = Math.max(0, Math.min(1, Number.isFinite(score) ? score / 100 : 0));
  if (strength === 0) {
    return mode === 'focus' ? { ...point, z: point.z - 1.4 } : point;
  }
  const pull = strength * (mode === 'focus' ? 0.16 : 0.065);
  const lift = strength * (mode === 'focus' ? 2.1 : 0.9);
  return {
    x: point.x + (anchor.x - point.x) * pull,
    y: point.y + (anchor.y - point.y) * pull,
    z: point.z + lift,
  };
}
