export interface ShellWindowInfo {
  handle: string;
  processId: number;
  title: string;
  visible: boolean;
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function getInvoke(): TauriInvoke {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    throw new Error('Native shell controls are only available in the LumenDeck desktop app.');
  }
  return invoke;
}

function windowCommand(command: string, handle: string): Promise<void> {
  return getInvoke()<void>(command, { handle });
}

export const shellClient = {
  listWindows(): Promise<ShellWindowInfo[]> {
    return getInvoke()<ShellWindowInfo[]>('list_windows');
  },

  focusWindow(handle: string): Promise<void> {
    return windowCommand('focus_window', handle);
  },

  minimizeWindow(handle: string): Promise<void> {
    return windowCommand('minimize_window', handle);
  },

  maximizeWindow(handle: string): Promise<void> {
    return windowCommand('maximize_window', handle);
  },

  restoreWindow(handle: string): Promise<void> {
    return windowCommand('restore_window', handle);
  },

  closeWindow(handle: string): Promise<void> {
    return windowCommand('close_window', handle);
  },

  isWindowAlive(handle: string): Promise<boolean> {
    return getInvoke()<boolean>('is_window_alive', { handle });
  },

  launchExplorer(): Promise<void> {
    return getInvoke()<void>('launch_explorer');
  },
};
