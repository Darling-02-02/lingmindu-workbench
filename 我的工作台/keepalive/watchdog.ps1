# Workbench engine watchdog (ASCII only).
# Keeps "D:\AAAlingmindu_wb" (the DSH engine + shell) running all the time.
# - Single instance (lock file).
# - If the shell process is gone -> relaunch via 启动.vbs (name built from chars to stay ASCII).
# - Backoff + hourly cap so a broken install cannot cause a relaunch storm.
# - Appends to keepalive.log (rotated at 1 MB).

param(
  [string]$Root = 'D:\AAAlingmindu_wb',
  [int]$IntervalSec = 30,
  [int]$MaxLaunchesPerHour = 12
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $Root 'keepalive.log'
$lock = Join-Path $Root 'keepalive.lock'

function Write-Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
      Move-Item $log ($log + '.1') -Force
    }
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  } catch {}
}

# ---- single instance -------------------------------------------------------
try {
  $fs = [System.IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None')
  $fs.SetLength(0)
  $b = [System.Text.Encoding]::ASCII.GetBytes("pid=$PID started=" + (Get-Date).ToString('s'))
  $fs.Write($b, 0, $b.Length)
  $fs.Flush()
} catch {
  exit 0   # another watchdog holds the lock
}

# ---- helpers ---------------------------------------------------------------
# "启动.vbs" written as char codes so this file stays pure ASCII
$startName = [string][char]0x542F + [string][char]0x52A8 + '.vbs'
$startVbs = Join-Path $Root $startName

function Get-ShellProcesses {
  # Detect by executable path, not by command line: the shell's own command line is
  # relative ("node_modules\electron\dist\electron.exe" .) and contains no absolute path.
  $out = @()
  $prefix = $Root.TrimEnd('\').ToLower() + '\'
  foreach ($p in (Get-Process -Name 'electron' -ErrorAction SilentlyContinue)) {
    try {
      if ($null -ne $p.Path -and $p.Path.ToLower().StartsWith($prefix)) { $out += $p }
    } catch {}
  }
  return $out
}

function Test-EnginePort {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', 3093, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { $c.Close(); return $false }
    $c.EndConnect($iar); $c.Close(); return $true
  } catch { return $false }
}

function Start-Shell {
  if (-not (Test-Path $startVbs)) { Write-Log 'ERROR start script missing'; return }
  # wscript returns immediately; the vbs itself detaches the electron process
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $startVbs + '"') -WindowStyle Hidden
  Write-Log 'LAUNCH via start.vbs'
}

# ---- main loop -------------------------------------------------------------
Write-Log ("watchdog start  pid=$PID  interval=${IntervalSec}s  root=$Root")
$launchTimes = New-Object System.Collections.ArrayList
$lastState = ''

while ($true) {
  $shells = Get-ShellProcesses
  $portUp = Test-EnginePort

  if ($shells.Count -gt 0) {
    $state = if ($portUp) { 'UP' } else { 'STARTING' }
  } else {
    $state = 'DOWN'

    # hourly cap
    $cut = (Get-Date).AddHours(-1)
    while ($launchTimes.Count -gt 0 -and $launchTimes[0] -lt $cut) { $launchTimes.RemoveAt(0) }

    if ($launchTimes.Count -lt $MaxLaunchesPerHour) {
      Start-Shell
      [void]$launchTimes.Add((Get-Date))
    } else {
      Write-Log 'CAP hit - not relaunching (check the shell manually)'
    }
  }

  if ($state -ne $lastState) {
    Write-Log ("state=$state  shells=" + $shells.Count + "  port3093=" + $portUp)
    $lastState = $state
  }

  Start-Sleep -Seconds $IntervalSec
}
