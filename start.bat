@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ==============================================
echo    Bilibili Danmaku Bot - Starting...
echo    Service runs in background (no window)
echo    Browser will open the bot page automatically
echo ==============================================

REM Kill any old instance on port 3000 first (avoid port conflict + stale code)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr LISTEN') do (
  taskkill /F /PID %%P 2>nul
)
timeout /t 1 /nobreak >nul

REM Start node hidden in background (VBS wrapper, no console window, logs to files)
wscript //nologo "%~dp0start-hidden.vbs"
timeout /t 3 /nobreak >nul

REM Read actual port written by server.js (auto-fallback if 3000 is occupied)
set DPORT=3000
if exist "%~dp0save\port.txt" set /p DPORT=<"%~dp0save\port.txt"
start "" http://localhost:%DPORT%
echo.
echo Done! You can close this window - the bot keeps running.
echo To stop: double-click the stop script in this folder
echo   (or close the bot page and wait 7s - it shuts down itself)
timeout /t 6 /nobreak >nul
exit
