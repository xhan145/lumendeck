/**
 * Thin, browser-safe wrapper around the Tauri updater + process plugins.
 *
 * Design constraints (see docs/superpowers/specs/2026-07-07-release-and-updater-design.md):
 * - Feature-detect the desktop shell with {@link isTauri}. In the browser / dev
 *   server / vitest the plugin code never runs and never throws — callers get a
 *   `{ available: false, reason: 'desktop-only' }` sentinel instead.
 * - The `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` packages are
 *   imported with a GUARDED, DYNAMIC `import()` inside the `isTauri()` branch. They
 *   are never imported at module top level, so `vite build`, `vite dev`, and the
 *   Node test run do not need the native modules resolved/loaded. The `@ts-ignore`
 *   lets `tsc --noEmit` stay clean whether or not the packages are installed in the
 *   current checkout (the orchestrator installs them for the signed build; vite
 *   bundles them into a lazy chunk that only the desktop shell ever fetches).
 */

/** Normalized result shared by {@link checkForUpdate} and {@link downloadAndInstall}. */
export interface UpdateCheckResult {
  /** True when a newer version is available (check) or was installed (install). */
  available: boolean;
  /** The target version, when known. */
  version?: string;
  /** Release notes / changelog body, when provided by the manifest. */
  notes?: string;
  /** A loud, human-readable failure reason. Present only on error. */
  error?: string;
  /** Non-error sentinel, e.g. `'desktop-only'` in the browser. */
  reason?: string;
}

/** Progress phases emitted while downloading + installing an update. */
export type UpdateProgress =
  | { phase: 'started'; totalBytes?: number }
  | { phase: 'downloading'; downloadedBytes: number; totalBytes?: number; fraction?: number }
  | { phase: 'finished' };

// Minimal structural shapes for the plugin objects we touch. Kept local so this
// module type-checks without the native packages being installed.
interface PluginDownloadEvent {
  event?: 'Started' | 'Progress' | 'Finished';
  data?: { contentLength?: number; chunkLength?: number };
}
interface PluginUpdate {
  version: string;
  body?: string | null;
  downloadAndInstall(onEvent?: (event: PluginDownloadEvent) => void): Promise<void>;
}

// The pending update object returned by check(), reused by downloadAndInstall so
// we don't hit the network twice.
let pendingUpdate: PluginUpdate | null = null;

/** Are we running inside the Tauri desktop shell (vs a plain browser)? */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown updater error';
  }
}

/**
 * Ask the update endpoint whether a newer signed build exists.
 * Never throws — failures come back as `{ available: false, error }`.
 * In the browser returns `{ available: false, reason: 'desktop-only' }`.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { available: false, reason: 'desktop-only' };
  try {
    // @ts-ignore optional native module — present only in the Tauri desktop build
    const updater = await import('@tauri-apps/plugin-updater');
    const update = (await updater.check()) as PluginUpdate | null;
    if (!update) {
      pendingUpdate = null;
      return { available: false };
    }
    pendingUpdate = update;
    return { available: true, version: update.version, notes: update.body ?? undefined };
  } catch (err) {
    return { available: false, error: messageOf(err) };
  }
}

/**
 * Download + install the pending update (from the most recent {@link checkForUpdate},
 * or a fresh check if none is cached). Does NOT relaunch — that is a deliberate,
 * separate {@link relaunch} step so the UI can present an explicit "Relaunch"
 * moment and the user never loses in-flight work. Both plugins are still used:
 * updater for download+install here, process for the restart in {@link relaunch}.
 *
 * Never throws — failures come back as `{ available: false, error }`.
 */
export async function downloadAndInstall(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<UpdateCheckResult> {
  if (!isTauri()) return { available: false, reason: 'desktop-only' };
  try {
    let update = pendingUpdate;
    if (!update) {
      // @ts-ignore optional native module — present only in the Tauri desktop build
      const updater = await import('@tauri-apps/plugin-updater');
      update = (await updater.check()) as PluginUpdate | null;
      pendingUpdate = update;
    }
    if (!update) return { available: false };

    let total: number | undefined;
    let downloaded = 0;
    await update.downloadAndInstall((event: PluginDownloadEvent) => {
      switch (event.event) {
        case 'Started':
          total = event.data?.contentLength;
          onProgress?.({ phase: 'started', totalBytes: total });
          break;
        case 'Progress':
          downloaded += event.data?.chunkLength ?? 0;
          onProgress?.({
            phase: 'downloading',
            downloadedBytes: downloaded,
            totalBytes: total,
            fraction: total && total > 0 ? Math.min(1, downloaded / total) : undefined,
          });
          break;
        case 'Finished':
          onProgress?.({ phase: 'finished' });
          break;
        default:
          break;
      }
    });
    return { available: true, version: update.version };
  } catch (err) {
    return { available: false, error: messageOf(err) };
  }
}

/**
 * Restart the app so a freshly installed update takes effect.
 * Never throws — returns `{ error }` on failure, `{ reason: 'desktop-only' }` in
 * the browser. On success the process is replaced and this never resolves.
 */
export async function relaunch(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { available: false, reason: 'desktop-only' };
  try {
    // @ts-ignore optional native module — present only in the Tauri desktop build
    const process = await import('@tauri-apps/plugin-process');
    await process.relaunch();
    return { available: true };
  } catch (err) {
    return { available: false, error: messageOf(err) };
  }
}
