import { describe, expect, it, vi } from 'vitest';
import {
  ActionBroker,
  DEFAULT_ACTION_POLICY,
  SHELL_ACTION_REGISTRY,
  type ActionDefinition,
} from '../src/core/shell/actions';

function action<Input, Output>(
  id: string,
  risk: ActionDefinition<Input, Output>['risk'],
  execute: ActionDefinition<Input, Output>['execute'],
): ActionDefinition<Input, Output> {
  return {
    id,
    title: id,
    capability: 'test',
    risk,
    execute,
  };
}

describe('shell ActionBroker', () => {
  it('allows read-only and reversible actions by default', async () => {
    const broker = new ActionBroker();
    const read = action('test.read', 'read-only', vi.fn(async () => 42));

    await expect(broker.run(read, undefined, { source: 'user' })).resolves.toBe(42);
    expect(read.execute).toHaveBeenCalledOnce();
    expect(broker.audit.at(-1)?.ok).toBe(true);
    expect(broker.audit.at(-1)?.capability).toBe('test');
  });

  it('requires explicit approval for stateful actions', async () => {
    const broker = new ActionBroker();
    const stateful = action('test.stateful', 'stateful', vi.fn(async () => 'done'));

    await expect(
      broker.run(stateful, undefined, { source: 'automation' }),
    ).rejects.toThrow('requires explicit approval');

    expect(stateful.execute).not.toHaveBeenCalled();

    await expect(
      broker.run(stateful, undefined, { source: 'automation', approved: true }),
    ).resolves.toBe('done');
  });

  it('never lets approval override a deny policy', async () => {
    const broker = new ActionBroker(DEFAULT_ACTION_POLICY);
    const destructive = action('test.delete', 'destructive', vi.fn(async () => undefined));

    await expect(
      broker.run(destructive, undefined, { source: 'ai', approved: true }),
    ).rejects.toThrow('denied by policy');

    expect(destructive.execute).not.toHaveBeenCalled();
  });
});


describe('shell action registry', () => {
  it('registers recovery status as read-only and Explorer fallback as reversible', () => {
    expect(SHELL_ACTION_REGISTRY.get('recovery.status')).toMatchObject({
      capability: 'recovery.read',
      risk: 'read-only',
    });
    expect(SHELL_ACTION_REGISTRY.get('recovery.explorer.launch')).toMatchObject({
      capability: 'recovery.explorer',
      risk: 'reversible',
    });
  });

  it('keeps window close behind the stateful approval class', () => {
    expect(SHELL_ACTION_REGISTRY.get('window.close')).toMatchObject({
      capability: 'window.control',
      risk: 'stateful',
    });
  });
});
