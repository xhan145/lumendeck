import { shellClient, type ShellWindowInfo } from './client';

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
  risk: ActionRisk;
  execute(input: Input): Promise<Output>;
}

export interface ActionAuditEntry {
  id: string;
  actionId: string;
  source: ActionSource;
  risk: ActionRisk;
  decision: ActionDecision;
  ok: boolean;
  timestamp: string;
  error?: string;
}

export type ActionPolicy = Record<ActionRisk, ActionDecision>;

export const DEFAULT_ACTION_POLICY: ActionPolicy = {
  'read-only': 'allow',
  reversible: 'allow',
  stateful: 'ask',
  destructive: 'deny',
  'security-sensitive': 'deny',
};

export const SHELL_ACTIONS = {
  listWindows: {
    id: 'window.list',
    risk: 'read-only',
    execute: () => shellClient.listWindows(),
  } satisfies ActionDefinition<void, ShellWindowInfo[]>,

  focusWindow: {
    id: 'window.focus',
    risk: 'reversible',
    execute: ({ handle }: { handle: number }) => shellClient.focusWindow(handle),
  } satisfies ActionDefinition<{ handle: number }, void>,

  launchExplorer: {
    id: 'recovery.explorer.launch',
    risk: 'reversible',
    execute: () => shellClient.launchExplorer(),
  } satisfies ActionDefinition<void, void>,
};

export class ActionBroker {
  readonly audit: ActionAuditEntry[] = [];

  constructor(private readonly policy: ActionPolicy = DEFAULT_ACTION_POLICY) {}

  decisionFor(risk: ActionRisk): ActionDecision {
    return this.policy[risk];
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

      this.audit.push({
        id: crypto.randomUUID(),
        actionId: action.id,
        source: context.source,
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
      this.audit.push({
        id: crypto.randomUUID(),
        actionId: action.id,
        source: context.source,
        risk: action.risk,
        decision,
        ok: true,
        timestamp,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.push({
        id: crypto.randomUUID(),
        actionId: action.id,
        source: context.source,
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
