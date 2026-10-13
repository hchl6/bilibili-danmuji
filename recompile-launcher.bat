@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  Recompile Bili Danmu Bot.exe (new cat icon)
echo ============================================
echo.

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [FAILED] csc.exe not found. Please install .NET Framework 4.x.
  pause
  exit /b 1
)

echo Using: %CSC%
echo.

"%CSC%" /nologo /target:winexe /platform:anycpu /r:System.Windows.Forms.dll /win32icon:icon.ico "/out:Bili Danmu Bot.exe" launcher\DanmujiLauncher.cs

if errorlevel 1 (
  echo.
  echo [FAILED] Compile error above. If "Bili Danmu Bot.exe" is running, close it first.
) else (
  echo.
  echo [OK] Done! "Bili Danmu Bot.exe" icon updated to cat.
)
echo.
pause
endlocal
