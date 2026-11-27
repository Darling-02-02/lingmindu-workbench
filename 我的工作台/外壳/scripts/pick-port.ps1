# pick-port.ps1 -- 给 launch-inner.cmd 挑一个没被占用的 CDP 调试端口
#
# 为什么要这个：强杀 electron 后，调试端口的 socket 会被死掉的进程留下（netstat 显示
# LISTENING，但 Get-Process 查不到那个 PID，HTTP 也不响应），固定端口用几次就废了。
# 从 9227 起往上找一个当前没有 LISTEN 的端口，写进 外壳\data\debug-port.txt，
# launch-inner.cmd 用它启动 electron，外壳脚本（cdp-eval.mjs 等）也从同一个文件读。
#
# 输出：端口号一行（别加别的东西，launch-inner.cmd 的 for /f 直接吃这一行）。
$ErrorActionPreference = 'SilentlyContinue'

$dataDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

$port = 9227
while ($port -lt 9261) {
    $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $busy) { break }
    $port++
}

$out = Join-Path $dataDir 'debug-port.txt'
[System.IO.File]::WriteAllText($out, "$port`r`n", [System.Text.Encoding]::ASCII)
Write-Output $port
