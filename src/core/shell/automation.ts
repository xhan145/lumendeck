import {
  shellActionBroker,
  SHELL_ACTION_REGISTRY,
  type ActionBroker,
  type ActionContext,
  type RegisteredShellAction,
} from './actions';

export type WorkflowFailureMode = 'stop' | 'continue';

export interface ShellWorkflowStep {
  id: string;
  action: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  approved?: boolean;
  onError?: WorkflowFailureMode;
}

export interface ShellWorkflow {
  id: string;
  name: string;
  version: 1;
  steps: ShellWorkflowStep[];
}

export interface WorkflowStepResult {
  stepId: string;
  action: string;
  ok: boolean;
  error?: string;
}

export interface WorkflowRunResult {
  workflowId: string;
  ok: boolean;
  stoppedAt?: string;
  steps: WorkflowStepResult[];
}

export type ShellActionRegistry = Map<string, RegisteredShellAction>;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, actionId: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Action ${actionId} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ShellWorkflowRunner {
  constructor(
    private readonly broker: ActionBroker = shellActionBroker,
    private readonly registry: ShellActionRegistry = SHELL_ACTION_REGISTRY,
  ) {}

  validate(workflow: ShellWorkflow): string[] {
    const errors: string[] = [];

    if (!workflow.id.trim()) errors.push('Workflow id is required.');
    if (!workflow.name.trim()) errors.push('Workflow name is required.');
    if (workflow.version !== 1) errors.push('Unsupported workflow version.');
    if (workflow.steps.length === 0) errors.push('Workflow requires at least one step.');

    const seen = new Set<string>();
    for (const step of workflow.steps) {
      if (!step.id.trim()) errors.push('Every workflow step requires an id.');
      if (seen.has(step.id)) errors.push(`Duplicate workflow step id: ${step.id}`);
      seen.add(step.id);

      if (!this.registry.has(step.action)) {
        errors.push(`Unknown action: ${step.action}`);
      }

      if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
        errors.push(`Invalid timeout for step ${step.id}.`);
      }
    }

    return errors;
  }

  async run(workflow: ShellWorkflow): Promise<WorkflowRunResult> {
    const errors = this.validate(workflow);
    if (errors.length > 0) {
      throw new Error(errors.join(' '));
    }

    const results: WorkflowStepResult[] = [];

    for (const step of workflow.steps) {
      const action = this.registry.get(step.action)!;
      const context: ActionContext = {
        source: 'automation',
        approved: step.approved === true,
      };

      try {
        const execution = this.broker.run(
          action as never,
          (step.args ?? undefined) as never,
          context,
        );

        await withTimeout(execution, step.timeoutMs ?? 15_000, action.id);
        results.push({ stepId: step.id, action: step.action, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          stepId: step.id,
          action: step.action,
          ok: false,
          error: message,
        });

        if ((step.onError ?? 'stop') === 'stop') {
          return {
            workflowId: workflow.id,
            ok: false,
            stoppedAt: step.id,
            steps: results,
          };
        }
      }
    }

    return {
      workflowId: workflow.id,
      ok: results.every((step) => step.ok),
      steps: results,
    };
  }
}

export const shellWorkflowRunner = new ShellWorkflowRunner();
