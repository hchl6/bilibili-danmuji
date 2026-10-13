@echo off
echo ==============================================
echo    Stop Bilibili Danmaku Bot (port 3000)
echo ==============================================
set "COUNT=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr LISTEN') do (
  taskkill /F /PID %%P 2>nul
  if not errorlevel 1 (
    echo Stopped PID %%P
    set /a COUNT+=1
  )
)
if %COUNT%==0 echo Bot is not running
echo.
pause
