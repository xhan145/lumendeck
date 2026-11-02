import { shellClient, type RecoveryStatus, type ShellWindowInfo } from './client';
import { persistActionAudit } from './audit';
import { DEFAULT_SHELL_POLICY, loadShellPolicy, saveShellPolicy } from './policy';

export type ActionRisk =
  | 'read-only'
  | 'reversible'
  | 'stateful'
  | 'destructive'
  | 'security-sensitive';

export type ActionDecision = 'allow' | 'ask' | 'deny';
export type ActionSource = 'user' | 'automation' | 'ai' | 'system';

export interface ActionContext {
  source: ActionSource;
  approved?: boolean;
}

export interface ActionDefinition<Input, Output> {
  id: string;
  title: string;
  capability: string;
  risk: ActionRisk;
  execute(input: Input): Promise<Output>;
}

export interface ActionAuditEntry {
  id: string;
  actionId: string;
  source: ActionSource;
  capability: string;
  risk: ActionRisk;
  decision: ActionDecision;
  ok: boolean;
  timestamp: string;
  error?: string;
}

export type ActionPolicy = Record<ActionRisk, ActionDecision>;

export const DEFAULT_ACTION_POLICY: ActionPolicy = { ...DEFAULT_SHELL_POLICY };

export const SHELL_ACTIONS = {
  listWindows: {
    id: 'window.list',
    title: 'List windows',
    capability: 'window.read',
    risk: 'read-only',
    execute: () => shellClient.listWindows(),
  } satisfies ActionDefinition<void, ShellWindowInfo[]>,

  isWindowAlive: {
    id: 'window.isAlive',
    title: 'Check window',
    capability: 'window.read',
    risk: 'read-only',
    execute: ({ handle }: { handle: string }) => shellClient.isWindowAlive(handle),
  } satisfies ActionDefinition<{ handle: string }, boolean>,

  focusWindow: {
    id: 'window.focus',
    title: 'Focus window',
    capability: 'window.control',
    risk: 'reversible',
    execute: ({ handle }: { handle: string }) => shellClient.focusWindow(handle),
  } satisfies ActionDefinition<{ handle: string }, void>,

  minimizeWindow: {
    id: 'window.minimize',
    title: 'Minimize window',
    capability: 'window.control',
    risk: 'reversible',
    execute: ({ handle }: { handle: string }) => shellClient.minimizeWindow(handle),
  } satisfies ActionDefinition<{ handle: string }, void>,

  maximizeWindow: {
    id: 'window.maximize',
    title: 'Maximize window',
    capability: 'window.control',
    risk: 'reversible',
    execute: ({ handle }: { handle: string }) => shellClient.maximizeWindow(handle),
  } satisfies ActionDefinition<{ handle: string }, void>,

  restoreWindow: {
    id: 'window.restore',
    title: 'Restore window',
    capability: 'window.control',
    risk: 'reversible',
    execute: ({ handle }: { handle: string }) => shellClient.restoreWindow(handle),
  } satisfies ActionDefinition<{ handle: string }, void>,

  closeWindow: {
    id: 'window.close',
    title: 'Close window',
    capability: 'window.control',
    risk: 'stateful',
    execute: ({ handle }: { handle: string }) => shellClient.closeWindow(handle),
  } satisfies ActionDefinition<{ handle: string }, void>,

  recoveryStatus: {
    id: 'recovery.status',
    title: 'Recovery status',
    capability: 'recovery.read',
    risk: 'read-only',
    execute: () => shellClient.recoveryStatus(),
  } satisfies ActionDefinition<void, RecoveryStatus>,

  launchExplorer: {
    id: 'recovery.explorer.launch',
    title: 'Launch Explorer',
    capability: 'recovery.explorer',
    risk: 'reversible',
    execute: () => shellClient.launchExplorer(),
  } satisfies ActionDefinition<void, void>,
};

export type RegisteredShellAction = (typeof SHELL_ACTIONS)[keyof typeof SHELL_ACTIONS];

export class ActionBroker {
  readonly audit: ActionAuditEntry[] = [];

  constructor(private policy: ActionPolicy = loadShellPolicy().risks) {}

  decisionFor(risk: ActionRisk): ActionDecision {
    return this.policy[risk];
  }

  getPolicy(): ActionPolicy {
    return { ...this.policy };
  }

  setPolicy(policy: ActionPolicy, persist = true): void {
    this.policy = { ...policy };
    if (persist) saveShellPolicy(this.policy);
  }

  private record(entry: ActionAuditEntry): void {
    this.audit.push(entry);
    persistActionAudit(entry);
  }

  async run<Input, Output>(
    action: ActionDefinition<Input, Output>,
    input: Input,
    context: ActionContext,
  ): Promise<Output> {
    const decision = this.decisionFor(action.risk);
    const timestamp = new Date().toISOString();

    if (decision === 'deny' || (decision === 'ask' && !context.approved)) {
      const reason = decision === 'deny'
        ? `Action ${action.id} is denied by policy.`
        : `Action ${action.id} requires explicit approval.`;

      this.record({
        id: crypto.randomUUID(),
        actionId: action.id,
        source: context.source,
        capability: action.capability,
        risk: action.risk,
        decision,
        ok: false,
        timestamp,
        error: reason,
      });
      throw new Error(reason);
    }

    try {
      const result = await action.execute(input);
      this.record({
        id: crypto.randomUUID(),
        actionId: action.id,
        source: context.source,
        capability: action.capability,
        risk: action.risk,
        decision,
        ok: true,
        timestamp,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record({
        id: crypto.randomUUID(),
        actionId: action.id,
        source: context.source,
        capability: action.capability,
        risk: action.risk,
        decision,
        ok: false,
        timestamp,
        error: message,
      });
      throw error;
    }
  }
}

export const shellActionBroker = new ActionBroker();

export const SHELL_ACTION_REGISTRY = new Map<string, RegisteredShellAction>(
  Object.values(SHELL_ACTIONS).map((action) => [action.id, action]),
);
