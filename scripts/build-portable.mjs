#!/usr/bin/env node
/**
 * Assemble a self-contained portable LumenDeck: bundled Python + the stdlib
 * bridge + the built SPA + a launcher. Unzip → double-click LumenDeck.bat → the
 * bridge serves the whole app at http://127.0.0.1:8787 in any browser, with real
 * LOCAL GPU rendering — no MSI, no system Python.
 *
 *   node scripts/build-portable.mjs
 *
 * Runs fetch-python / vite build first if their outputs are missing.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY_SRC = join(ROOT, 'src-tauri', 'resources', 'python');
const DIST_SRC = join(ROOT, 'dist');
const OUT_ROOT = join(ROOT, 'dist-portable');

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NAME = `LumenDeck-${VERSION}-portable-win-x64`;
const OUT = join(OUT_ROOT, NAME);

function log(m) { console.log(`  [portable] ${m}`); }
function fail(m) { console.error(`\n✗ [portable] ${m}`); process.exit(1); }
function npm(args) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: ROOT, stdio: 'inherit' });
}

const LAUNCHER = `@echo off
REM LumenDeck portable — real local rendering in your browser, no install.
cd /d "%~dp0"
REM Use the bundled Python (so Install runtime + model needs nothing preinstalled).
set "LUMENDECK_PYTHON=%~dp0python\\python.exe"
echo Freeing port 8787 if something is using it...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
echo Starting LumenDeck at http://127.0.0.1:8787 ...
start "" http://127.0.0.1:8787
"%~dp0python\\python.exe" "%~dp0bridge\\server.py" --port 8787
`;

const README = `LumenDeck ${VERSION} — Portable (Windows x64)
================================================

Real, local generative image + video rendering in your browser. No installer,
no system Python required.

QUICK START
  1. Double-click  LumenDeck.bat
  2. Your browser opens to http://127.0.0.1:8787
  3. It works immediately with the built-in Mock renderer (procedural previews).

REAL GPU RENDERING (optional)
  In the app, open Settings → Backend → "Install runtime + model". LumenDeck uses
  the bundled Python to download the CUDA PyTorch runtime + a Stable Diffusion
  model on first use (a few GB, one time). An NVIDIA GPU is recommended; without
  one it falls back to CPU (slow) — every render says which it used.

WHAT'S INSIDE
  python\\   the bundled Python (python-build-standalone) — used only to build the
            local render runtime; nothing is installed to your system.
  bridge\\   the local render server (pure Python standard library).
  dist\\     the LumenDeck web app the bridge serves.

Everything stays on your machine. Close the console window to stop LumenDeck.
`;

function copyBridge(dest) {
  const skipDirs = new Set(['dist', 'build', '__pycache__', '.pytest_cache']);
  cpSync(join(ROOT, 'bridge'), dest, {
    recursive: true,
    filter: (src) => {
      const b = basename(src);
      if (skipDirs.has(b)) return false;
      if (b.startsWith('test_')) return false;
      if (b === 'build_sidecar.py') return false;
      if (b.endsWith('.pyc')) return false;
      return true;
    },
  });
}

function main() {
  if (!existsSync(join(PY_SRC, 'python.exe'))) {
    log('bundled Python missing — fetching');
    npm(['run', 'fetch:python']);
  }
  if (!existsSync(join(DIST_SRC, 'index.html'))) {
    log('dist missing — building the web app');
    npm(['run', 'build']);
  }
  log(`assembling ${NAME}`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(PY_SRC, join(OUT, 'python'), { recursive: true });
  copyBridge(join(OUT, 'bridge'));
  cpSync(DIST_SRC, join(OUT, 'dist'), { recursive: true });
  writeFileSync(join(OUT, 'LumenDeck.bat'), LAUNCHER, 'utf8');
  writeFileSync(join(OUT, 'README.txt'), README, 'utf8');

  // Zip via PowerShell Compress-Archive (always present on Windows; GNU tar in
  // git-bash cannot write zip and mangles C:\ paths).
  const zip = join(OUT_ROOT, `${NAME}.zip`);
  rmSync(zip, { force: true });
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zip}' -Force`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    log(`zip: ${zip}`);
  } catch (err) {
    log(`(zip skipped: ${(err.stderr || err.message || '').toString().slice(0, 160)}) — folder is ready at ${OUT}`);
  }
  log(`ready: ${OUT}`);
}

main();
