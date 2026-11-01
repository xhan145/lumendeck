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

export const shellClient = {
  listWindows(): Promise<ShellWindowInfo[]> {
    return getInvoke()<ShellWindowInfo[]>('list_windows');
  },

  focusWindow(handle: string): Promise<void> {
    return getInvoke()<void>('focus_window', { handle });
  },

  launchExplorer(): Promise<void> {
    return getInvoke()<void>('launch_explorer');
  },
};
