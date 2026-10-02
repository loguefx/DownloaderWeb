# uninstall-task.ps1 — stop and remove the engine scheduled task.
#
# Usage (PowerShell, as Administrator):
#   .\uninstall-task.ps1
#
# This removes the task only. It does NOT delete the app, the app data folder
# (%APPDATA%\webvideodownloader — settings, API key, queue, library ledger),
# or any downloaded video.

param(
  [string]$TaskName = "WebVideoDownloaderEngine"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "Run this script from an elevated (Administrator) PowerShell."
  exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "Task '$TaskName' is not installed." -ForegroundColor Yellow
  exit 0
}

# Stop it if it is running.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# Kill any engine process this task started (electron.exe with --engine).
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object { $_.CommandLine -match '--engine' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Task '$TaskName' removed." -ForegroundColor Green
