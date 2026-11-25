@echo off
chcp 936 >nul
rem 把历史上堆在「未分组」的刷B站会话补登记进工作区 D:\AAA刷B站
rem 必须按顺序：先停引擎（运行中的引擎只用内存态，改盘会被覆盖回去）→ 改盘 → 起引擎
rem ⚠️ 双击运行会重启引擎：正在跑的对话会中断（记录还在，重新打开那个会话就能接着聊）
setlocal
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"

echo [1/3] 停引擎
"%NODE%" 工具\引擎常驻.mjs stop
timeout /t 3 /nobreak >nul

echo [2/3] 归组（D:\AAAdafeiyu 的会话 → D:\AAA刷B站 工作区，并取消归档）
"%NODE%" 工具\工作区归组.mjs --apply --from "D:\AAAdafeiyu" --to-path "D:\AAA刷B站" --unarchive

echo [3/3] 起引擎
"%NODE%" 工具\引擎常驻.mjs start

echo.
echo 完成。打开工作台，左侧「AAA刷B站」展开就能看到这些会话了。
pause
