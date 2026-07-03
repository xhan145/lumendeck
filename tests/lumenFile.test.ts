import { describe, it, expect } from 'vitest';
import { buildLumenFile, parseLumenFile } from '../src/core/lumenFile';
import { createDefaultWorkflow } from '../src/core/workflow';

describe('lumenFile', () => {
  const wf = createDefaultWorkflow();

  it('round-trips a workflow through export/import', () => {
    const text = JSON.stringify(buildLumenFile(wf, [], new Date('2026-07-03T00:00:00Z')));
    const res = parseLumenFile(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.file.workflow.nodes.length).toBe(wf.nodes.length);
      expect(res.file.workflow.edges.length).toBe(wf.edges.length);
    }
  });

  it('rejects malformed JSON', () => {
    expect(parseLumenFile('{not json').ok).toBe(false);
  });

  it('rejects wrong schemaVersion', () => {
    const bad = JSON.stringify({ schemaVersion: 99, app: 'LumenDeck', workflow: wf, rackPresets: [] });
    const res = parseLumenFile(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/schema/i);
  });

  it('rejects missing workflow shape', () => {
    const res = parseLumenFile(JSON.stringify({ schemaVersion: 1, app: 'LumenDeck', rackPresets: [] }));
    expect(res.ok).toBe(false);
  });
});
