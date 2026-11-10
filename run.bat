@echo off
setlocal
REM Legacy browser-mode launcher. Does not replace Windows Explorer.
REM Never forcibly kill whatever program owns the bridge port.
cd /d "%~dp0" || (
  echo [LumenDeck] Could not enter the repository directory.
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo [LumenDeck] Python was not found on PATH.
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [LumenDeck] npm.cmd not found. Install Node.js and open a new terminal.
  exit /b 1
)

REM A port collision must be diagnosed, not "fixed" by killing an unknown PID.
netstat -ano | findstr /C:":8787 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  echo [LumenDeck] Port 8787 is already in use.
  echo [LumenDeck] Stop only your own LumenDeck bridge or choose another launch mode.
  exit /b 1
)

echo [LumenDeck] Building the latest browser interface...
call npm.cmd run build
if errorlevel 1 (
  echo [LumenDeck] Frontend build failed. The server was not started.
  exit /b 1
)

echo [LumenDeck] Opening http://127.0.0.1:8787/
start "" "http://127.0.0.1:8787/"
python bridge\server.py --port 8787
exit /b %errorlevel%
