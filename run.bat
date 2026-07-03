@echo off
REM LumenDeck — one-click real rendering.
REM Builds the app (first time), then runs the bridge which serves the UI AND the
REM API on http://127.0.0.1:8787 (same origin, so the browser never fails to fetch).
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo Building the LumenDeck app (first run only)...
  call npm install
  call npm run build
)

echo.
echo Freeing port 8787 if something is using it...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1

echo Starting LumenDeck at http://127.0.0.1:8787 ...
start "" http://127.0.0.1:8787
python bridge\server.py --port 8787
