import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const BRIDGE_PORT = 8787;

// Single source of truth for the app version: read it from package.json and inject
// it as the __APP_VERSION__ global (used by src/state/storeConstants.ts). This
// applies to both the production build and vitest (they share this config), so the
// displayed version can never drift from package.json again. A dedicated
// versionSync test asserts package.json / tauri.conf.json / Cargo.toml all agree.
const PKG_VERSION: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => resolve(false));
    setTimeout(() => done(false), 500);
  });
}

/** Dev-only: autostart the Python render bridge alongside `npm run dev`. */
function bridgePlugin(): PluginOption {
  let child: ChildProcess | null = null;
  return {
    name: 'lumendeck-bridge',
    apply: 'serve',
    async configureServer() {
      if (await portOpen(BRIDGE_PORT)) {
        console.log(`\n[bridge] already running on :${BRIDGE_PORT} — reusing it.`);
        return;
      }
      const python = process.env.LUMENDECK_PYTHON || 'python';
      console.log(`\n[bridge] starting ${python} bridge/server.py on :${BRIDGE_PORT} ...`);
      // Keep an open stdin pipe: the bridge's watchdog exits on stdin EOF, so a
      // live pipe keeps it running; closing it (on dev-server exit) stops it cleanly.
      child = spawn(python, ['server.py', '--port', String(BRIDGE_PORT)], {
        cwd: 'bridge',
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, LUMENDECK_PARENT_WATCH: '1' },
      });
      child.on('error', (err) =>
        console.warn(`[bridge] could not start (${err.message}). Install Python, or run "python bridge/server.py" manually.`),
      );
      const stop = () => {
        if (child && !child.killed) child.kill();
        child = null;
      };
      process.on('exit', stop);
      process.on('SIGINT', () => { stop(); process.exit(0); });
      process.on('SIGTERM', () => { stop(); process.exit(0); });
    },
  };
}

const bridgeProxy = {
  target: `http://127.0.0.1:${BRIDGE_PORT}`,
  changeOrigin: true,
};

export default defineConfig({
  plugins: [react(), bridgePlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(PKG_VERSION),
  },
  server: {
    port: Number(process.env.PORT) || 5178,
    // Same-origin API: the browser calls /health etc. on the dev server, which
    // forwards to the bridge. Avoids all cross-origin / private-network blocks.
    proxy: {
      '/health': bridgeProxy,
      '/models': bridgeProxy,
      '/model-folder': bridgeProxy,
      '/generate': bridgeProxy,
      '/diffusers': bridgeProxy,
      '/progress': bridgeProxy,
      '/civitai': bridgeProxy,
      '/cloud': bridgeProxy,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
