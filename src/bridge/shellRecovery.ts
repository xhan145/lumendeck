import { invoke } from '@tauri-apps/api/core';

export type RecoveryAction = 'explorer' | 'task-manager';

async function invokeRecovery(command: string): Promise<void> {
  await invoke(command);
}

export async function runRecoveryAction(action: RecoveryAction): Promise<void> {
  if (action === 'explorer') {
    await invokeRecovery('open_explorer');
    return;
  }
  await invokeRecovery('open_task_manager');
}
