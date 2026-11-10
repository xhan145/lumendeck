@echo off
setlocal
REM Browser-only development launcher. Vite starts the Python bridge itself.
REM For the native Windows shell interface, use npm.cmd run tauri:dev.
cd /d "%~dp0" || (
  echo [LumenDeck] Could not enter the repository directory.
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [LumenDeck] npm.cmd not found. Install Node.js and open a new terminal.
  exit /b 1
)

echo [LumenDeck] Starting Vite at http://127.0.0.1:14200/
echo [LumenDeck] The bridge is managed by Vite on port 8787.
echo [LumenDeck] No unrelated processes will be terminated.
call npm.cmd run dev
exit /b %errorlevel%
