import { describe, expect, it } from 'vitest';
import { recoveryCommand } from '../src/core/shell/recovery';

describe('shell recovery command map', () => {
  it('maps Explorer to the allow-listed native command', () => {
    expect(recoveryCommand('explorer')).toBe('open_explorer');
  });

  it('maps Task Manager to the allow-listed native command', () => {
    expect(recoveryCommand('task-manager')).toBe('open_task_manager');
  });
});
