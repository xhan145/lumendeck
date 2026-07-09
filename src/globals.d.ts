/**
 * Build-time constants injected by Vite's `define` (see vite.config.ts).
 *
 * `__APP_VERSION__` is replaced with the version string read from package.json at
 * build/test time, making package.json the single source of truth for the app
 * version. `storeConstants.ts` guards its absence for non-Vite import paths.
 */
declare const __APP_VERSION__: string;
