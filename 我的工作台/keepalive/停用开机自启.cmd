@echo off
rem 关掉「开机自启 + 保活」。2026-11-27 用户反馈：刚开机 CPU 就被拉满。
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%\workbench-keepalive.vbs" del /q "%STARTUP%\workbench-keepalive.vbs"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog.ps1*' -and $_.Name -eq 'powershell.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.
echo 已停用：开机不再自动拉起工作台，保活进程也已结束。
echo 想恢复双击「启用开机自启.cmd」。
echo.
pause