import { invoke } from '@tauri-apps/api/core';
import { recoveryCommand, type RecoveryAction } from '../core/shell/recovery';

export type { RecoveryAction } from '../core/shell/recovery';

export async function runRecoveryAction(action: RecoveryAction): Promise<void> {
  await invoke(recoveryCommand(action));
}
