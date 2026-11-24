@echo off
rem internal launcher for the workbench shell (ASCII name so launch.vbs stays ASCII too)
rem 1) delete ELECTRON_RUN_AS_NODE for real: set VAR= deletes it, setting it to "" only empties it
rem 3) --remote-debugging-port=9224 so the UI can be verified over CDP (no screenshot needed)
rem    (9223 leaked a zombie LISTEN socket on this box after a force-kill; 9224 is the new default, tools probe both)
rem 2) engine cold boot takes 40-55s; the shell budget was raised to 180s in shell\main.js
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=1
set DSH_PORT=3093
chcp 936 >nul
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "SHELL=%ROOT%\外壳"
set "ENVDATA=%ROOT%\引擎数据\.dsh"
if not exist "%ENVDATA%" mkdir "%ENVDATA%"
set "DSH_CUSTOMER_HOME=%ENVDATA%"
set "DSH_SHELL_DIR=%SHELL%"
cd /d "%SHELL%"
if not exist "node_modules\electron\dist\electron.exe" (
  echo deps missing: run npm install in the shell folder
  exit /b 2
)
start "workbench" "node_modules\electron\dist\electron.exe" . --remote-debugging-port=9224
exit /b 0
