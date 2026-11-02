import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_POLICY,
  loadShellPolicy,
  sanitizeShellPolicy,
  saveShellPolicy,
} from '../src/core/shell/policy';

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  get length() { return this.data.size; }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('shell policy persistence', () => {
  it('sanitizes malformed policy values back to safe defaults', () => {
    const result = sanitizeShellPolicy({
      version: 1,
      risks: {
        'read-only': 'banana',
        reversible: 'deny',
        stateful: 'allow',
      },
    });

    expect(result.risks['read-only']).toBe(DEFAULT_SHELL_POLICY['read-only']);
    expect(result.risks.reversible).toBe('deny');
    expect(result.risks.stateful).toBe('allow');
    expect(result.risks.destructive).toBe('deny');
    expect(result.risks['security-sensitive']).toBe('deny');
  });

  it('round-trips a persisted policy', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });

    saveShellPolicy({
      'read-only': 'allow',
      reversible: 'ask',
      stateful: 'deny',
      destructive: 'deny',
      'security-sensitive': 'deny',
    });

    expect(loadShellPolicy().risks).toEqual({
      'read-only': 'allow',
      reversible: 'ask',
      stateful: 'deny',
      destructive: 'deny',
      'security-sensitive': 'deny',
    });
  });
});
