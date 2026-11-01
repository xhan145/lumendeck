import { describe, expect, it, vi } from 'vitest';
import {
  ActionBroker,
  DEFAULT_ACTION_POLICY,
  type ActionDefinition,
} from '../src/core/shell/actions';

describe('shell ActionBroker', () => {
  it('allows read-only and reversible actions by default', async () => {
    const broker = new ActionBroker();
    const read = {
      id: 'test.read',
      risk: 'read-only',
      execute: vi.fn(async () => 42),
    } satisfies ActionDefinition<void, number>;

    await expect(broker.run(read, undefined, { source: 'user' })).resolves.toBe(42);
    expect(read.execute).toHaveBeenCalledOnce();
    expect(broker.audit.at(-1)?.ok).toBe(true);
  });

  it('requires explicit approval for stateful actions', async () => {
    const broker = new ActionBroker();
    const stateful = {
      id: 'test.stateful',
      risk: 'stateful',
      execute: vi.fn(async () => 'done'),
    } satisfies ActionDefinition<void, string>;

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
    const destructive = {
      id: 'test.delete',
      risk: 'destructive',
      execute: vi.fn(async () => undefined),
    } satisfies ActionDefinition<void, void>;

    await expect(
      broker.run(destructive, undefined, { source: 'ai', approved: true }),
    ).rejects.toThrow('denied by policy');

    expect(destructive.execute).not.toHaveBeenCalled();
  });
});
