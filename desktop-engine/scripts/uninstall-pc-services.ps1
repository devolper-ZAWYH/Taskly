<#
.SYNOPSIS
  Removes the Taskly PC services installed by install-pc-services.ps1.

.DESCRIPTION
  Run from an ELEVATED Windows PowerShell:

      powershell -ExecutionPolicy Bypass -File .\uninstall-pc-services.ps1

  Every step asks yes/no first:
    * stop and remove the "taskly-model-server" service, then "ollama"
    * restore the Ollama tray app's auto-start (Startup shortcut / Run value)
      from the backup the installer made
    * remove the firewall rule
    * restore the AC sleep/hibernate settings the installer changed
    * delete the service folders (WinSW exe, XML, logs)

  Models, keys and data are NEVER touched: ~\.ollama\models and the
  desktop-engine folder (model-server.key, journal, models\) stay as they are.
  The verified WinSW download in C:\ProgramData\TasklyAI\_download is kept
  unless you agree to delete the whole TasklyAI folder at the end.

.PARAMETER Port
  The model server port the firewall rule was created for (default 8765).
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

$ServiceRoot  = 'C:\ProgramData\TasklyAI'
$BackupDir    = Join-Path $ServiceRoot 'backup'
$ManifestFile = Join-Path $BackupDir 'pc-services-backup.json'
$FirewallRuleName = "Taskly model server (TCP $Port)"
$OllamaId      = 'ollama'
$ModelServerId = 'taskly-model-server'

# ---- small helpers (same as the installer) --------------------------------

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "   $Text" }
function Write-Ok([string]$Text)   { Write-Host "   [ok] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   [!]  $Text" -ForegroundColor Yellow }

function Confirm-Action([string]$Question) {
    while ($true) {
        $answer = (Read-Host "$Question (yes/no)").Trim().ToLowerInvariant()
        if ($answer -eq 'yes' -or $answer -eq 'y') { return $true }
        if ($answer -eq 'no' -or $answer -eq 'n') { return $false }
        Write-Host '   Please answer yes or no.'
    }
}

function Invoke-Quiet {
    param([string]$File, [string[]]$Arguments)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $text = (& $File @Arguments 2>&1 | Out-String)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    return @{ Code = $code; Output = $text }
}

function Wait-ServiceGone([string]$Name, [int]$Seconds = 30) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-OurService([string]$Id) {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Id'" -ErrorAction SilentlyContinue
    if (-not $svc) { return $false }
    return ([string]$svc.PathName).IndexOf($ServiceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Remove-OurService([string]$Id) {
    $svc = Get-Service -Name $Id -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    if ($svc.Status -ne 'Stopped') {
        Write-Info "Stopping $Id (and anything that depends on it)..."
        Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue
        try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90)) } catch { Write-Warn "$Id did not report Stopped in 90 s." }
    }
    $exe = Join-Path (Join-Path $ServiceRoot $Id) "$Id.exe"
    if (Test-Path -LiteralPath $exe) {
        $r = Invoke-Quiet $exe @('uninstall')
        if ($r.Code -ne 0) {
            Write-Warn "WinSW uninstall exit $($r.Code); falling back to sc.exe delete."
            $null = Invoke-Quiet 'sc.exe' @('delete', $Id)
        }
    } else {
        $null = Invoke-Quiet 'sc.exe' @('delete', $Id)
    }
    if (-not (Wait-ServiceGone $Id)) {
        Write-Warn "Service '$Id' is still registered (marked for deletion). It disappears once nothing holds it open (close services.msc) or after a reboot."
    } else {
        Write-Ok "Service '$Id' removed."
    }
}

# ===========================================================================

Write-Host ''
Write-Host 'Taskly PC services uninstaller' -ForegroundColor White
Write-Host 'Models, keys and data are left untouched.'

$manifest = $null
if (Test-Path -LiteralPath $ManifestFile) {
    try { $manifest = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json }
    catch { Write-Warn "Could not parse $ManifestFile : $($_.Exception.Message)" }
}

# ---- 1. services ------------------------------------------------------------

# Model server first: it depends on Ollama.
foreach ($id in @($ModelServerId, $OllamaId)) {
    Write-Step "Service '$id'"
    if (-not (Get-Service -Name $id -ErrorAction SilentlyContinue)) {
        Write-Info 'Not installed.'
        continue
    }
    if (-not (Test-OurService $id)) {
        Write-Warn "A service named '$id' exists but does not run from $ServiceRoot, so it is not ours. Leaving it alone."
        continue
    }
    if (Confirm-Action "Stop and remove the '$id' service?") {
        Remove-OurService $id
    }
}

# ---- 2. tray auto-start -------------------------------------------------------

Write-Step 'Ollama tray app auto-start'
$startupItems = @()
$runItems = @()
if ($manifest) {
    if ($manifest.startup) { $startupItems = @($manifest.startup) }
    if ($manifest.run)     { $runItems     = @($manifest.run) }
}
if ($startupItems.Count -eq 0 -and $runItems.Count -eq 0) {
    Write-Info 'No tray auto-start backup found (the installer did not remove one). Nothing to restore.'
} else {
    foreach ($s in $startupItems) { Write-Info "Startup shortcut : $($s.original)" }
    foreach ($r in $runItems)     { Write-Info "Run value        : $($r.key)\$($r.name)" }
    if (Confirm-Action 'Restore the Ollama tray app auto-start at sign-in?') {
        foreach ($s in $startupItems) {
            if (-not (Test-Path -LiteralPath $s.backup)) { Write-Warn "Backup file missing: $($s.backup)"; continue }
            if (Test-Path -LiteralPath $s.original) {
                Write-Info "Already present: $($s.original)"
                continue
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $s.original) | Out-Null
            Move-Item -LiteralPath $s.backup -Destination $s.original
            Write-Ok "Restored $($s.original)"
        }
        foreach ($r in $runItems) {
            if ($r.key -like 'HKCU:*' -and -not (Test-Path -LiteralPath $r.key)) { continue }
            try {
                New-ItemProperty -LiteralPath $r.key -Name $r.name -Value $r.value -PropertyType String -Force | Out-Null
                Write-Ok "Restored Run value $($r.name)"
            } catch { Write-Warn "Could not restore $($r.key)\$($r.name): $($_.Exception.Message)" }
        }
        # The tray entries are back where they were; drop them from the manifest.
        $manifest | Add-Member -NotePropertyName startup -NotePropertyValue @() -Force
        $manifest | Add-Member -NotePropertyName run -NotePropertyValue @() -Force
        $json = $manifest | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($ManifestFile, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Info 'The tray app starts again at your next sign-in (or launch "Ollama" from the Start menu).'
    }
}

# ---- 3. firewall ----------------------------------------------------------------

Write-Step "Firewall rule '$FirewallRuleName'"
if (Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue) {
    if (Confirm-Action 'Remove this inbound firewall rule?') {
        Remove-NetFirewallRule -DisplayName $FirewallRuleName
        Write-Ok 'Rule removed.'
    }
} else {
    Write-Info 'No such rule (use -Port if you installed with a different port).'
}

# ---- 4. power settings ------------------------------------------------------------

Write-Step 'Power settings'
if ($manifest -and $manifest.power) {
    $p = $manifest.power
    Write-Info "Before the installer: sleep on AC = $($p.standbyAcMinutes) min, hibernate on AC = $($p.hibernateAcMinutes) min (0 = never, -1 = unknown)."
    if ($p.standbyAcMinutes -ge 0 -and $p.hibernateAcMinutes -ge 0) {
        if (Confirm-Action 'Restore those AC sleep/hibernate timeouts?') {
            $a = Invoke-Quiet 'powercfg.exe' @('/change', 'standby-timeout-ac', [string]$p.standbyAcMinutes)
            $b = Invoke-Quiet 'powercfg.exe' @('/change', 'hibernate-timeout-ac', [string]$p.hibernateAcMinutes)
            if ($a.Code -eq 0 -and $b.Code -eq 0) { Write-Ok 'AC timeouts restored.' } else { Write-Warn "powercfg returned $($a.Code)/$($b.Code)." }
        }
    }
    if ($p.hibernateFileWasOn -eq $true) {
        if (Confirm-Action 'Hibernation was ON before; turn it back on (powercfg /hibernate on)?') {
            $h = Invoke-Quiet 'powercfg.exe' @('/hibernate', 'on')
            if ($h.Code -eq 0) { Write-Ok 'Hibernation on.' } else { Write-Warn "powercfg /hibernate on returned $($h.Code): $($h.Output)" }
        }
    }
} else {
    Write-Info 'The installer changed no power settings (no backup). Nothing to restore.'
}

# ---- 5. files ------------------------------------------------------------------------

Write-Step 'Service folders'
foreach ($id in @($ModelServerId, $OllamaId)) {
    $dir = Join-Path $ServiceRoot $id
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
        Write-Info "$dir stays: service '$id' is still registered."
        continue
    }
    if (Confirm-Action "Delete $dir (WinSW exe, XML and LOGS)?") {
        Remove-Item -LiteralPath $dir -Recurse -Force
        Write-Ok "Deleted $dir"
    }
}
$leftovers = @(Get-ChildItem -LiteralPath $ServiceRoot -Force -ErrorAction SilentlyContinue)
if ($leftovers.Count -gt 0 -and -not (Get-Service -Name $OllamaId -ErrorAction SilentlyContinue) -and -not (Get-Service -Name $ModelServerId -ErrorAction SilentlyContinue)) {
    Write-Info "Still in $ServiceRoot : $(($leftovers | ForEach-Object { $_.Name }) -join ', ')  (backup records, cached WinSW download)"
    if (Confirm-Action "Delete the whole $ServiceRoot folder? (you lose the backup records; models/keys/data are unaffected)") {
        Remove-Item -LiteralPath $ServiceRoot -Recurse -Force
        Write-Ok "Deleted $ServiceRoot"
    }
}

Write-Step 'Done'
Write-Info 'Untouched: ~\.ollama\models, desktop-engine\model-server.key, journal and models\.'
