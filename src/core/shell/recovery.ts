export type RecoveryAction = 'explorer' | 'task-manager';
export type RecoveryCommand = 'open_explorer' | 'open_task_manager';

export function recoveryCommand(action: RecoveryAction): RecoveryCommand {
  return action === 'explorer' ? 'open_explorer' : 'open_task_manager';
}
