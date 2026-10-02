# install-task.ps1 — run the WebVideoDownloader engine as a scheduled task.
#
# Why a scheduled task and not a Windows service:
#   Electron (Chromium) needs a desktop session. A real Windows service runs
#   in Session 0 with no desktop, so the browser-based discovery breaks.
#   The usual setup is a dedicated Windows PC (behind Mullvad) with Windows
#   auto-logon for a local account; the task then starts the engine at logon
#   and restarts it if it crashes.
#
# Usage (PowerShell, as Administrator):
#   .\install-task.ps1                      # defaults: app dir = repo root
#   .\install-task.ps1 -AppDir C:\apps\wvd # explicit app dir
#
# What it does:
#   - verifies the Electron binary exists in <AppDir>\node_modules\electron
#   - creates task "WebVideoDownloaderEngine":
#       trigger : at logon (for the current user)
#       action  : cmd /c "<electron.exe>" "<AppDir>" --engine  >>  %APPDATA%\webvideodownloader\engine.log 2>&1
#       policy  : run at highest privileges, restart 3x on failure, no time limit
#   - starts it now (if the user is logged in)
#
# Remove it with .\uninstall-task.ps1 (also run as Administrator).

param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [string]$TaskName = "WebVideoDownloaderEngine"
)

$ErrorActionPreference = "Stop"

# --- admin check -------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "Run this script from an elevated (Administrator) PowerShell."
  exit 1
}

if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) {
  Write-Error "App dir not found: $AppDir"
  exit 1
}
$AppDir = (Resolve-Path -LiteralPath $AppDir).Path

# --- locate the Electron binary ---------------------------------------------
$electronExe = Join-Path $AppDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $electronExe)) {
  # Fall back to the path.txt indirection (matches scripts/start.js).
  $pathFile = Join-Path $AppDir "node_modules\electron\path.txt"
  if ((Test-Path $pathFile) -and (Test-Path (Join-Path $AppDir "node_modules\electron\dist"))) {
    $electronExe = Join-Path (Join-Path $AppDir "node_modules\electron\dist") "electron.exe"
  }
}
if (-not (Test-Path -LiteralPath $electronExe)) {
  Write-Error "Electron binary not found under $AppDir\node_modules\electron. Run 'npm install' in $AppDir first (on THIS Windows machine)."
  exit 1
}

# --- log file ----------------------------------------------------------------
$logDir = Join-Path $env:APPDATA "webvideodownloader"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "engine.log"

# --- build the task ------------------------------------------------------------
$cmdArgs = "/c `"$electronExe`" `"$AppDir`" --engine >> `"$logFile`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmdArgs -WorkingDirectory $AppDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERDOMAIN\$env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
# No execution time limit (the engine runs indefinitely).
$settings.ExecutionTimeLimit = [TimeSpan]::Zero

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

# Replace any existing task of the same name.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "WebVideoDownloader headless engine (Jellyfin integration): downloads and places finished video onto the NAS library folders." | Out-Null

Write-Host ""
Write-Host "Task '$TaskName' installed." -ForegroundColor Green
Write-Host "  App dir : $AppDir"
Write-Host "  Log file: $logFile"
Write-Host "  Trigger : at logon for $env:USERNAME (needs Windows auto-logon for unattended use)"
Write-Host ""

# --- optional: start now -------------------------------------------------------
try {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started now. Check the log with:  Get-Content -Tail 20 -Wait '$logFile'"
} catch {
  Write-Warning "Task registered but not started now: $($_.Exception.Message)"
}
