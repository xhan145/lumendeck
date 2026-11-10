import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/bridge/files';
import {
  buildFileContextLens, clampContextThreshold, compareFileContext,
  CONTEXT_MAX_LINKS, projectFileContext,
} from '../src/core/shell/fileContext';

const make = (name: string, extension: string, kind: FileEntry['kind'],
  modifiedMs: number | null = null): FileEntry => ({
  name, path: 'C:\\Local\\' + name, extension, kind,
  modifiedMs, sizeBytes: 42, isDirectory: kind === 'folder',
  isReadOnly: false, isSymlink: false,
});

describe('5D Context is an explainable, offline file-metadata projection', () => {
  const anchor = make('Project-Orbit-mix.wav', 'wav', 'audio', 1_700_000_000_000);
  const related = make('Project-Orbit-mix.flac', 'flac', 'audio', 1_700_000_000_000);
  const alternate = make('Project-Orbit-notes.md', 'md', 'document', 1_699_999_000_000);
  const generic = make('generic-video.mp4', 'mp4', 'video', 1_610_000_000_000);

  it('extracts transparent evidence but never claims file contents are related', () => {
    const relation = compareFileContext(anchor, related);
    expect(relation?.score).toBeGreaterThanOrEqual(70);
    expect(relation?.evidence.some((item) => item.kind === 'same-basename')).toBe(true);
    expect(relation?.evidence.some((item) => item.kind === 'modified-nearby')).toBe(true);
    expect(compareFileContext(anchor, anchor)).toBeNull();
    expect(compareFileContext(anchor, generic)).toBeNull();
  });

  it('uses filename-token overlap across kinds, without inventing semantic links', () => {
    const relation = compareFileContext(anchor, alternate)!;
    expect(relation.score).toBeGreaterThanOrEqual(35);
    expect(relation.evidence.some((item) => item.kind === 'shared-token')).toBe(true);
    expect(relation.evidence.some((item) => item.kind === 'same-extension')).toBe(false);
  });

  it('filters, limits, sorts and remains deterministic regardless of input order', () => {
    const entries = [generic, related, anchor, alternate];
    const a = buildFileContextLens(entries, anchor.path, 35)!;
    const b = buildFileContextLens([...entries].reverse(), anchor.path, 35)!;
    expect(a.relations.map((r) => r.entry.path)).toEqual(b.relations.map((r) => r.entry.path));
    expect(a.relations.every((r) => r.score >= 35)).toBe(true);
    expect(a.scoreByPath.has(generic.path)).toBe(false);
    expect(a.relations.length).toBeGreaterThan(0);
    expect(buildFileContextLens(entries, generic.path, 85)?.relations).toEqual([]);
    expect(buildFileContextLens(entries, 'C:\\Local\\not-listed.txt')).toBeNull();
    expect(buildFileContextLens(entries, null)).toBeNull();
    expect(buildFileContextLens(entries, anchor.path, 25, 0)?.relations).toEqual([]);
    expect(buildFileContextLens([...Array.from({ length: 100 }, (_, i) =>
      make('Project-Orbit-mix-' + i + '.wav', 'wav', 'audio')), anchor], anchor.path, 25)!
      .relations.length).toBeLessThanOrEqual(CONTEXT_MAX_LINKS);
  });

  it('clamps confidence threshold even on malformed input', () => {
    expect(clampContextThreshold(-10)).toBe(25);
    expect(clampContextThreshold(500)).toBe(85);
    expect(clampContextThreshold(Number.NaN)).toBe(35);
    expect(clampContextThreshold(50.6)).toBe(51);
  });

  it('does not turn folder membership into proof of direct relation', () => {
    const a = make('Archive', '', 'folder');
    const b = make('Unrelated', '', 'folder');
    expect(compareFileContext(a, b)?.evidence).toEqual([
      { kind: 'same-kind', label: 'Both folder items', weight: 12 },
    ]);
    expect(buildFileContextLens([a, b], a.path, 25)?.relations).toEqual([]);
  });

  it('projects a real context score over a 4D location without changing identity', () => {
    const point = { x: 10, y: 1, z: 3 };
    const focus = { x: 0, y: 0, z: 0 };
    const original = structuredClone(point);
    expect(projectFileContext(point, focus, 90, 'off', false)).toEqual(point);
    expect(projectFileContext(point, focus, 90, 'focus', true)).toEqual(point);
    const drawn = projectFileContext(point, focus, 90, 'focus', false);
    expect(drawn.x).toBeLessThan(point.x);
    expect(drawn.z).toBeGreaterThan(point.z);
    expect(projectFileContext(point, focus, 0, 'focus', false).z).toBeLessThan(point.z);
    expect(point).toEqual(original);
    expect(projectFileContext(point, focus, Infinity, 'links', false)).toEqual(point);
  });
});
