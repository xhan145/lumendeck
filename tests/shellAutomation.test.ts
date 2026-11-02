import { describe, expect, it, vi } from 'vitest';
import {
  ActionBroker,
  type ActionDefinition,
  type RegisteredShellAction,
} from '../src/core/shell/actions';
import {
  ShellWorkflowRunner,
  type ShellWorkflow,
} from '../src/core/shell/automation';

function registered(
  id: string,
  risk: ActionDefinition<unknown, unknown>['risk'],
  execute: ActionDefinition<unknown, unknown>['execute'],
): RegisteredShellAction {
  return {
    id,
    title: id,
    capability: 'test',
    risk,
    execute,
  } as RegisteredShellAction;
}

describe('ShellWorkflowRunner', () => {
  it('rejects unknown actions before execution', async () => {
    const runner = new ShellWorkflowRunner(new ActionBroker(), new Map());
    const workflow: ShellWorkflow = {
      id: 'bad',
      name: 'Bad workflow',
      version: 1,
      steps: [{ id: 'one', action: 'missing.action' }],
    };

    await expect(runner.run(workflow)).rejects.toThrow('Unknown action');
  });

  it('runs registered actions sequentially through the broker', async () => {
    const order: string[] = [];
    const first = registered('test.first', 'read-only', vi.fn(async () => { order.push('first'); }));
    const second = registered('test.second', 'reversible', vi.fn(async () => { order.push('second'); }));

    const runner = new ShellWorkflowRunner(
      new ActionBroker(),
      new Map([[first.id, first], [second.id, second]]),
    );

    const result = await runner.run({
      id: 'sequence',
      name: 'Sequence',
      version: 1,
      steps: [
        { id: 'a', action: first.id },
        { id: 'b', action: second.id },
      ],
    });

    expect(result.ok).toBe(true);
    expect(order).toEqual(['first', 'second']);
  });

  it('stops when a stateful action lacks approval', async () => {
    const close = registered('test.close', 'stateful', vi.fn(async () => undefined));
    const later = registered('test.later', 'read-only', vi.fn(async () => undefined));
    const runner = new ShellWorkflowRunner(
      new ActionBroker(),
      new Map([[close.id, close], [later.id, later]]),
    );

    const result = await runner.run({
      id: 'gated',
      name: 'Gated',
      version: 1,
      steps: [
        { id: 'close', action: close.id },
        { id: 'later', action: later.id },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe('close');
    expect(later.execute).not.toHaveBeenCalled();
  });

  it('can continue after a failed step when explicitly configured', async () => {
    const bad = registered('test.bad', 'read-only', vi.fn(async () => { throw new Error('boom'); }));
    const good = registered('test.good', 'read-only', vi.fn(async () => 'ok'));
    const runner = new ShellWorkflowRunner(
      new ActionBroker(),
      new Map([[bad.id, bad], [good.id, good]]),
    );

    const result = await runner.run({
      id: 'continue',
      name: 'Continue',
      version: 1,
      steps: [
        { id: 'bad', action: bad.id, onError: 'continue' },
        { id: 'good', action: good.id },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(good.execute).toHaveBeenCalledOnce();
  });
});
