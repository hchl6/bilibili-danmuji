@echo off
cd /d "%~dp0"
REM 启动透明弹幕窗（通过 VBS 隐藏启动，避免 start 命令参数传递问题）
wscript //nologo "%~dp0start-overlay.vbs"
exit
