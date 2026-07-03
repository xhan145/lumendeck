@echo off
REM LumenDeck launcher — starts the render bridge and the dev server together.
REM Double-click this file, or run it from any directory.
cd /d "%~dp0"

echo Freeing port 5178 if a stale dev server is running...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5178 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1

echo Starting LumenDeck render bridge (port 8787) in a new window...
start "LumenDeck Bridge" cmd /k "cd /d "%~dp0" && python bridge\server.py --port 8787"

echo Starting the LumenDeck app (dev server)...
echo When it prints a Local URL, open it in your browser.
npm run dev
