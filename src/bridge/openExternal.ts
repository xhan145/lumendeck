/**
 * Safe external-link opener shared by Support/Credits (and any future CTA).
 *
 * Mirrors the feature-detect pattern in {@link ./updater.ts}:
 * - In the Tauri desktop shell ({@link isTauri}) the `@tauri-apps/plugin-opener`
 *   package is loaded with a GUARDED, DYNAMIC `import()` so `vite build`, `vite dev`,
 *   and the Node test run never need the native module resolved at top level.
 * - In the browser / dev server / vitest it falls back to `window.open` with
 *   `noopener,noreferrer`.
 * - NEVER throws: any failure is swallowed (a dead link must not crash the UI).
 */

import { isTauri } from './updater';

/**
 * Open `url` in the user's default browser (desktop) or a new tab (web).
 * Never throws — a failure to open a link is silently ignored.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    if (isTauri()) {
      // @ts-ignore optional native module — present only in the Tauri desktop build
      const opener = await import('@tauri-apps/plugin-opener');
      await opener.openUrl(url);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } catch {
    // Intentionally ignored: opening an external link must never crash the app.
  }
}
