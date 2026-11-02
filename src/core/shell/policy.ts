import type { ActionPolicy } from './actions';

const STORAGE_KEY = 'lumendeck.shell.policy.v1';

export const DEFAULT_SHELL_POLICY: ActionPolicy = {
  'read-only': 'allow',
  reversible: 'allow',
  stateful: 'ask',
  destructive: 'deny',
  'security-sensitive': 'deny',
};

export interface PersistedShellPolicy {
  version: 1;
  risks: ActionPolicy;
}

function isDecision(value: unknown): value is ActionPolicy[keyof ActionPolicy] {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

export function sanitizeShellPolicy(value: unknown): PersistedShellPolicy {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<PersistedShellPolicy>;
  const risks = (raw.risks && typeof raw.risks === 'object' ? raw.risks : {}) as Partial<ActionPolicy>;

  return {
    version: 1,
    risks: {
      'read-only': isDecision(risks['read-only']) ? risks['read-only'] : DEFAULT_SHELL_POLICY['read-only'],
      reversible: isDecision(risks.reversible) ? risks.reversible : DEFAULT_SHELL_POLICY.reversible,
      stateful: isDecision(risks.stateful) ? risks.stateful : DEFAULT_SHELL_POLICY.stateful,
      // These classes are architectural hard-denies in the current shell runtime.
      // Persisted settings, localStorage edits, automation, or AI cannot relax them.
      destructive: 'deny',
      'security-sensitive': 'deny',
    },
  };
}

export function loadShellPolicy(): PersistedShellPolicy {
  if (typeof localStorage === 'undefined') {
    return { version: 1, risks: { ...DEFAULT_SHELL_POLICY } };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, risks: { ...DEFAULT_SHELL_POLICY } };
    return sanitizeShellPolicy(JSON.parse(raw));
  } catch {
    return { version: 1, risks: { ...DEFAULT_SHELL_POLICY } };
  }
}

export function saveShellPolicy(policy: ActionPolicy): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeShellPolicy({ version: 1, risks: policy })));
}
