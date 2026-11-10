import type { ActionAuditEntry } from './actions';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function getInvoke(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__?.core?.invoke ?? null;
}

export interface PersistedActionAudit {
  timestamp: string;
  actionId: string;
  source: string;
  capability: string;
  risk: string;
  decision: string;
  ok: boolean;
}

export function redactAuditEntry(entry: ActionAuditEntry): PersistedActionAudit {
  return {
    timestamp: entry.timestamp,
    actionId: entry.actionId,
    source: entry.source,
    capability: entry.capability,
    risk: entry.risk,
    decision: entry.decision,
    ok: entry.ok,
  };
}

export function persistActionAudit(entry: ActionAuditEntry): void {
  const invoke = getInvoke();
  if (!invoke) return;

  void invoke<void>('append_action_audit', { entry: redactAuditEntry(entry) }).catch(() => {
    // Audit persistence must never block or crash a user action.
  });
}

export async function getActionAuditPath(): Promise<string | null> {
  const invoke = getInvoke();
  if (!invoke) return null;

  try {
    return await invoke<string>('action_audit_path');
  } catch {
    return null;
  }
}
