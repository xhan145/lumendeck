import { describe, expect, it } from 'vitest';
import { redactAuditEntry } from '../src/core/shell/audit';

describe('persistent shell audit redaction', () => {
  it('excludes error text and any action arguments from the persisted record', () => {
    const persisted = redactAuditEntry({
      id: 'audit-1',
      actionId: 'window.close',
      source: 'automation',
      capability: 'window.control',
      risk: 'stateful',
      decision: 'ask',
      ok: false,
      timestamp: '2026-11-02T10:00:00.000Z',
      error: 'Sensitive path C:\\Users\\Example\\secret.txt',
    });

    expect(persisted).toEqual({
      actionId: 'window.close',
      source: 'automation',
      capability: 'window.control',
      risk: 'stateful',
      decision: 'ask',
      ok: false,
      timestamp: '2026-11-02T10:00:00.000Z',
    });
    expect(JSON.stringify(persisted)).not.toContain('secret.txt');
  });
});
