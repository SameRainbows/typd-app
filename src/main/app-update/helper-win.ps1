# Typd app-update helper, Windows. src/main/appUpdate.js copies this file into
# <userData>\app-update\, writes helper.json beside it and starts it hidden (Windows PowerShell 5.1,
# which every Windows 10 and 11 has) just before Typd quits for an update:
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File helper.ps1 <dir>
#
# 0. Start itself again (-Run) and exit. Node puts every process it starts into a job object that
#    is killed when Node exits -- Typd's quitting would take the helper with it -- but lets those
#    processes start others outside it. Node's `detached` would avoid the job, but PowerShell
#    without a console (DETACHED_PROCESS) exits at once without running anything.
# 1. Wait for Typd (OLD_PID) to exit, then for anything still running from inside its folder
#    (llama-server.exe, Electron's helpers): their files are locked while they run.
# 2. Move the staged Typd folder next to the installed one (NEWIN) and carry over what the package
#    leaves out (CARRY: the dictation model, llama.cpp when unchanged, a tester build's tester.json,
#    the uninstaller).
# 3. Swap: the installed folder becomes OLD and NEWIN takes its name (renames on one volume, retried
#    while a virus scanner holds a file). Start the new Typd.exe.
# 4. Wait for its verdict.json: "started", then "ok" or "failed". On "ok" delete OLD and set the
#    version Windows shows under Installed apps. On "failed", a crash or silence: stop it, put OLD
#    back with what was carried, start it.
# result.json says what happened: ok | bad | aborted, as on macOS. Everything is logged to helper.log.
param([Parameter(Mandatory = $true)][string]$Dir, [switch]$Run)

$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $Dir 'helper.log'

# Appended through a handle that lets others write too (Typd may still hold the file).
function Log([string]$m) {
  $line = '{0} helper: {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $m
  try {
    $fs = [IO.File]::Open($LogFile, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $b = [Text.Encoding]::UTF8.GetBytes($line + "`r`n")
    $fs.Write($b, 0, $b.Length)
    $fs.Close()
  } catch { }
}

if (-not $Run) {
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Process -Id $PID).Path
    $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" "' + $Dir + '" -Run'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $Dir
    $p = [Diagnostics.Process]::Start($psi)
    Log "helper started ($($p.Id))"
  } catch { Log "could not start the helper: $($_.Exception.Message)" }
  exit 0
}

$v = Get-Content -LiteralPath (Join-Path $Dir 'helper.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[IO.File]::WriteAllText((Join-Path $Dir 'helper.started'), [string]$PID)

$App = $v.APP; $New = $v.NEW; $NewIn = $v.NEWIN; $Old = $v.OLD; $Failed = $v.FAILED
$Version = $v.VERSION; $From = $v.FROM
$Carry = @(([string]$v.CARRY) -split "`n" | Where-Object { $_ })
$script:Carried = @()

function Result([string]$outcome, [string]$why) {
  $r = [ordered]@{ version = $Version; from = $From; outcome = $outcome; why = $why; at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
  $tmp = Join-Path $Dir 'result.json.tmp'
  [IO.File]::WriteAllText($tmp, ($r | ConvertTo-Json -Compress))
  Move-Item -LiteralPath $tmp -Destination (Join-Path $Dir 'result.json') -Force
  Log "result: $outcome ($why)"
}

function Wait-Gone([int]$Id, [int]$Seconds) {
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $p) { return $true }
  return $p.WaitForExit($Seconds * 1000)
}

# Processes whose executable is inside $Root.
function Inside([string]$Root) {
  $prefix = $Root.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

function Stop-Inside([string]$Root) {
  for ($i = 0; $i -lt 40; $i++) {
    $left = Inside $Root
    if ($left.Count -eq 0) { return }
    if ($i -eq 30) {
      Log ('still running from {0}: {1}; stopping them' -f $Root, (($left | ForEach-Object { "$($_.Name) $($_.ProcessId)" }) -join ', '))
      $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 500
  }
}

# A rename on one volume, retried for ~20 s while something holds a file; a copy across volumes.
function Move-Path([string]$From, [string]$To) {
  $parent = Split-Path -Parent $To
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  for ($i = 0; $i -lt 40; $i++) {
    try { Move-Item -LiteralPath $From -Destination $To -ErrorAction Stop; return $true } catch { $err = $_ }
    if (([IO.Path]::GetPathRoot($From)) -ne ([IO.Path]::GetPathRoot($To))) {
      try {
        Copy-Item -LiteralPath $From -Destination $To -Recurse -Force -ErrorAction Stop
        Remove-Item -LiteralPath $From -Recurse -Force -ErrorAction SilentlyContinue
        return $true
      } catch { Log "copy $From -> $To failed: $($_.Exception.Message)"; return $false }
    }
    Start-Sleep -Milliseconds 500
  }
  Log "move $From -> $To failed: $($err.Exception.Message)"
  return $false
}

function Carry-Over([string]$From, [string]$To) {
  foreach ($p in $Carry) {
    $rel = $p.Replace('/', '\')
    $src = Join-Path $From $rel; $dst = Join-Path $To $rel
    if ((Test-Path -LiteralPath $src) -and -not (Test-Path -LiteralPath $dst)) {
      if (-not (Move-Path $src $dst)) { return $false }
      $script:Carried += $p
      Log "carried $p"
    }
  }
  return $true
}

function Carry-Back([string]$From, [string]$To) {
  foreach ($p in $script:Carried) {
    $rel = $p.Replace('/', '\')
    $src = Join-Path $From $rel; $dst = Join-Path $To $rel
    if ((Test-Path -LiteralPath $src) -and -not (Test-Path -LiteralPath $dst)) {
      if (-not (Move-Path $src $dst)) { Log "could not put back $p" }
    }
  }
}

# CreateProcess directly, as Explorer would start it: no show-window override (with one, Windows
# would apply it to Typd's first window), the environment passed on, never a console window.
function Launch([string]$Folder) {
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $Folder 'Typd.exe'
    $psi.WorkingDirectory = $Dir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    Log "started $($psi.FileName) ($($p.Id))"
  } catch { Log "could not start $Folder\Typd.exe: $($_.Exception.Message)" }
}

function Abort([string]$why) {
  Log "aborted: $why"
  Result 'aborted' $why
  if (Test-Path -LiteralPath (Join-Path $App 'Typd.exe')) { Launch $App }
  exit 1
}

function Undo-New([string]$why) {
  Carry-Back $NewIn $App
  Remove-Item -LiteralPath $NewIn -Recurse -Force -ErrorAction SilentlyContinue
  Abort $why
}

Log "installing Typd $Version over $From at $App"
if (-not (Wait-Gone ([int]$v.OLD_PID) 60)) {
  Log "Typd ($($v.OLD_PID)) did not quit within 60 s; stopping it"
  Stop-Process -Id ([int]$v.OLD_PID) -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
Stop-Inside $App

if (-not (Test-Path -LiteralPath (Join-Path $App 'Typd.exe'))) { Abort "the installed app is not at $App" }
if (-not (Test-Path -LiteralPath (Join-Path $New 'Typd.exe'))) { Abort "the staged app is missing at $New" }
foreach ($leftover in @($NewIn, $Old, $Failed)) {
  if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Recurse -Force -ErrorAction SilentlyContinue }
}
if (-not (Move-Path $New $NewIn)) { Abort 'could not move the new version next to the installed one' }
if (-not (Carry-Over $App $NewIn)) { Undo-New 'could not carry the installed files over' }

if (-not (Move-Path $App $Old)) { Undo-New 'could not move the installed version aside (a file in it is in use)' }
if (-not (Move-Path $NewIn $App)) {
  if (-not (Move-Path $Old $App)) { Log "could not put the installed version back; it is at $Old" }
  Undo-New 'could not move the new version into place'
}
Log "swapped: $App is Typd $Version; $From waits at $Old"

Launch $App
$state = ''; $npid = 0
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $vf = Join-Path $Dir 'verdict.json'
  if (Test-Path -LiteralPath $vf) {
    try {
      $j = Get-Content -LiteralPath $vf -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
      if ($j.version -eq $Version) {
        $state = [string]$j.state; $npid = [int]$j.pid
        if ($state -eq 'ok' -or $state -eq 'failed') { break }
      }
    } catch { }   # caught mid-write: read again
  }
  if ($npid -eq 0 -and $sw.Elapsed.TotalSeconds -ge [int]$v.STARTED_TIMEOUT_S) { $state = 'silent'; break }
  if ($sw.Elapsed.TotalSeconds -ge [int]$v.VERDICT_TIMEOUT_S) { $state = 'timeout'; break }
  if ($npid -ne 0 -and -not (Get-Process -Id $npid -ErrorAction SilentlyContinue)) { $state = 'crashed'; break }
  Start-Sleep -Milliseconds 250
}

if ($state -eq 'ok') {
  Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Old) { Log "could not delete $Old entirely; Typd deletes the rest later" }
  # Installed apps shows the version the installer wrote; say the new one (per-user installs only).
  try {
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction Stop | ForEach-Object {
      $u = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).UninstallString
      if ($u -and $u.IndexOf($App.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version -ErrorAction SilentlyContinue
        Log "Installed apps now says $Version"
      }
    }
  } catch { }
  Result 'ok' "Typd $Version passed its start-up self-test"
  exit 0
}

switch ($state) {
  'failed' { $why = "Typd $Version failed its start-up self-test" }
  'crashed' { $why = "Typd $Version quit before its self-test finished" }
  'silent' { $why = "Typd $Version did not start within $($v.STARTED_TIMEOUT_S) s" }
  default { $why = "Typd $Version did not pass its self-test within $($v.VERDICT_TIMEOUT_S) s" }
}
Log "$why; putting $From back"
if ($npid -ne 0) {
  $p = Get-Process -Id $npid -ErrorAction SilentlyContinue
  if ($p) { Stop-Process -Id $npid -ErrorAction SilentlyContinue; if (-not $p.WaitForExit(10000)) { Stop-Process -Id $npid -Force -ErrorAction SilentlyContinue } }
}
Stop-Inside $App
if (Move-Path $App $Failed) {
  Carry-Back $Failed $Old
  if (Move-Path $Old $App) { Remove-Item -LiteralPath $Failed -Recurse -Force -ErrorAction SilentlyContinue }
  else { Log "could not put $From back; it is at $Old" }
} else {
  Log 'could not move the failed version aside'
}
Result 'bad' $why
Launch $App
exit 1
