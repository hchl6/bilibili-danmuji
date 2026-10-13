@echo off
title Uninstall Bilibili Danmaku Bot
echo ==============================================
echo   Uninstall Bilibili Danmaku Bot
echo ==============================================
echo.

REM ---- 1. Stop ALL bot processes (port 3000 + any node/python from this folder) ----
echo [1/4] Stopping bot processes...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr LISTEN') do (
  taskkill /F /PID %%P >nul 2>&1 && echo   Stopped server PID %%P
)
REM Kill every node/python whose command line contains this bot folder path
REM (covers: vbs-hidden node, player.py, orphan processes) - otherwise the exe
REM files inside runtime\ are locked and the folder cannot be fully deleted.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe'' or Name=''python.exe''' | Where-Object { $_.CommandLine -like '*bilibili-danmuji*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('  Stopped ' + $_.Name + ' PID ' + $_.ProcessId) }"
REM Wait for file locks to release before deleting
timeout /t 2 /nobreak >nul
echo.

REM ---- 2. Confirm before deleting ----
echo [2/4] This will PERMANENTLY DELETE the bot folder:
echo   %~dp0
echo.
set /p CONFIRM=Type YES to confirm uninstall: 
if /i not "%CONFIRM%"=="YES" (
  echo.
  echo Cancelled. Nothing was deleted.
  echo.
  pause
  exit /b 1
)

REM ---- 3. Clean temp files ----
echo [3/4] Cleaning temp files...
if exist "%~dp0save" rd /s /q "%~dp0save" >nul 2>&1
if exist "%~dp0tmp" rd /s /q "%~dp0tmp" >nul 2>&1
if exist "%~dp0log.txt" del /q "%~dp0log.txt" >nul 2>&1
if exist "%~dp0log-err.txt" del /q "%~dp0log-err.txt" >nul 2>&1
echo   Done.

REM ---- 4. Self-delete the whole folder (delayed, after this bat exits) ----
echo [4/4] Deleting bot folder...
echo.
echo ==============================================
echo   Uninstall complete. The bot folder will
echo   delete itself in a moment.
echo.
echo   Note: This bot is a green app - it writes NO
echo   registry entries, so nothing to clean there.
echo.
echo   Browser data: if you used "Scan QR login", your
echo   Bilibili cookie is stored in the browser for
echo   localhost:3000. To remove it: open the page,
echo   press F12 - Application - Local Storage -
echo   clear the localhost:3000 entries.
echo ==============================================
timeout /t 2 /nobreak >nul
REM Self-delete via PowerShell: wait 3s for this bat to exit, then Remove-Item
REM with retry (in case a file is still locked, retry once after 2s).
start "" powershell -NoProfile -Command "Start-Sleep 3; cd '%~dp0..'; Remove-Item -LiteralPath '%~dp0' -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Remove-Item -LiteralPath '%~dp0' -Recurse -Force -ErrorAction SilentlyContinue"
exit /b 0
