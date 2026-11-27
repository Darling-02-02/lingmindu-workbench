@echo off
rem internal launcher for the workbench shell (ASCII name so launch.vbs stays ASCII too)
rem 1) delete ELECTRON_RUN_AS_NODE for real: set VAR= deletes it, setting it to "" only empties it
rem 2) engine cold boot takes 40-55s; the shell budget was raised to 180s in shell\main.js
rem 3) --remote-debugging-port: shell\scripts\pick-port.ps1 picks a port that is NOT already
rem    listening and writes it to 外壳\data\debug-port.txt; the CDP helper scripts read that
rem    same file, so a zombie LISTEN socket (left by a force-kill) can never wedge the port.
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ATTACH_CONSOLE=1
set DSH_PORT=3093
chcp 936 >nul
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "SHELL=%ROOT%\外壳"
set "ENVDATA=%ROOT%\引擎数据\.dsh"
if not exist "%ENVDATA%" mkdir "%ENVDATA%"
if not exist "%SHELL%\data" mkdir "%SHELL%\data"
set "DSH_CUSTOMER_HOME=%ENVDATA%"
set "DSH_SHELL_DIR=%SHELL%"
cd /d "%SHELL%"
if not exist "node_modules\electron\dist\electron.exe" (
  echo deps missing: run npm install in the shell folder
  exit /b 2
)
set "DPORT=9227"
for /f "delims=" %%p in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%SHELL%\scripts\pick-port.ps1"') do set "DPORT=%%p"
start "workbench" "node_modules\electron\dist\electron.exe" . --remote-debugging-port=%DPORT%
exit /b 0