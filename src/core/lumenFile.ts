import type { RackPreset, Workflow } from './types';

/** Portable LumenDeck recipe file. */
export interface LumenFile {
  schemaVersion: 1;
  app: 'LumenDeck';
  savedAt: string;
  workflow: Workflow;
  rackPresets: RackPreset[];
}

export function buildLumenFile(workflow: Workflow, rackPresets: RackPreset[], now: Date): LumenFile {
  return { schemaVersion: 1, app: 'LumenDeck', savedAt: now.toISOString(), workflow, rackPresets };
}

function isWorkflow(w: unknown): w is Workflow {
  if (!w || typeof w !== 'object') return false;
  const c = w as Record<string, unknown>;
  return Array.isArray(c.nodes) && Array.isArray(c.edges) && typeof c.version === 'number';
}

/** Parse + validate a `.lumen` file. Never throws; returns a tagged result. */
export function parseLumenFile(
  text: string,
): { ok: true; file: LumenFile } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not a valid .lumen file (invalid JSON).' };
  }
  const d = data as Record<string, unknown>;
  if (d.schemaVersion !== 1) {
    return { ok: false, error: `Unsupported .lumen schema version: ${String(d.schemaVersion)}.` };
  }
  if (!isWorkflow(d.workflow)) {
    return { ok: false, error: 'The .lumen file has no valid workflow.' };
  }
  const rackPresets = Array.isArray(d.rackPresets) ? (d.rackPresets as RackPreset[]) : [];
  return {
    ok: true,
    file: {
      schemaVersion: 1,
      app: 'LumenDeck',
      savedAt: String(d.savedAt ?? ''),
      workflow: d.workflow,
      rackPresets,
    },
  };
}
