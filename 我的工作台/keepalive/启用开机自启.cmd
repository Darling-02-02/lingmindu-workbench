@echo off
rem 恢复「开机自启 + 保活」。默认是关的（2026-11-27 用户反馈开机 CPU 被拉满）。
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "开机自启-停用\workbench-keepalive.vbs" (
  echo 找不到 开机自启-停用\workbench-keepalive.vbs，没法恢复。
  pause
  exit /b 1
)
copy /y "开机自启-停用\workbench-keepalive.vbs" "%STARTUP%\workbench-keepalive.vbs" >nul
if exist "watchdog-start.vbs" start "" wscript.exe "%CD%\watchdog-start.vbs"
echo.
echo 已启用：以后开机会自动拉起工作台；保活进程现在也已启动。
echo 想关掉双击「停用开机自启.cmd」。
echo.
pause