<#
.SYNOPSIS
  Registers a weekly Windows scheduled task that keeps the knowledge base current.

.DESCRIPTION
  Runs `expert refresh`, which pulls repo updates and re-studies only what changed.
  Safe to re-run — it replaces its own task rather than stacking duplicates.

  The task is deliberately conservative: it only runs when the machine is on AC power
  and idle-friendly, it wakes nothing, and a missed run (laptop asleep) is retried when
  the machine is next available rather than skipped for the week.

.EXAMPLE
  .\scripts\schedule-refresh.ps1                      # Sundays, 03:00
  .\scripts\schedule-refresh.ps1 -Day Wednesday -At 21:30
  .\scripts\schedule-refresh.ps1 -Remove
#>
[CmdletBinding()]
param(
  [ValidateSet('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')]
  [string] $Day = 'Sunday',
  [string] $At = '03:00',
  [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$taskName = 'repos-expert weekly refresh'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed '$taskName'." -ForegroundColor Green
  } else {
    Write-Host "No task named '$taskName' to remove." -ForegroundColor Yellow
  }
  return
}

$entry = Join-Path $root 'dist\cli\index.js'
if (-not (Test-Path $entry)) {
  throw "Not built yet: $entry is missing. Run 'npm run build' first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH; the scheduled task would fail." }

# Log where a human will look for it, and keep only the last run's output.
$logDir = Join-Path $env:LOCALAPPDATA 'repos-expert'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'weekly-refresh.log'

# cmd wrapper purely to redirect stdout/stderr — schtasks has no log option.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$node`" `"$entry`" refresh > `"$log`" 2>&1`"" `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $At

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Re-studies repositories whose code changed since the last run.' `
  -Force | Out-Null

$next = (Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo).NextRunTime
Write-Host "Scheduled '$taskName'" -ForegroundColor Green
Write-Host "  when:    every $Day at $At"
Write-Host "  next:    $next"
Write-Host "  command: node $entry refresh"
Write-Host "  log:     $log"
Write-Host ""
Write-Host "  Run it now to test:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "  Remove it:           .\scripts\schedule-refresh.ps1 -Remove"
