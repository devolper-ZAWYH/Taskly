<#
.SYNOPSIS
  Installs Ollama and the Taskly model server as always-on Windows services
  (WinSW wrappers), so the GPU PC serves models from boot with nobody signed in.

.DESCRIPTION
  Run once, from an ELEVATED Windows PowerShell:

      powershell -ExecutionPolicy Bypass -File .\install-pc-services.ps1

  What it can do (every step asks yes/no first):
    * download + hash-verify WinSW (https://github.com/winsw/winsw, MIT)
    * install the "ollama" service        (ollama.exe serve, 127.0.0.1:11434)
    * install "taskly-model-server"       (python -m taskly_live serve ..., 0.0.0.0:8765)
    * stop the Ollama tray app auto-starting at sign-in (backed up for uninstall)
    * stop a running tray Ollama so two servers don't fight over port 11434
    * never sleep / hibernate on AC power (current values shown first)
    * open an inbound firewall rule for the model server (Private profile)
  It also CHECKS (never changes) Tailscale's "Run unattended" setting.

  Re-running is safe: existing services are stopped, removed and re-created
  from freshly written XML (no duplicates), then started again.

  It never touches models, keys or data: ~\.ollama\models and the
  desktop-engine folder (model-server.key, journal, models\) are left alone.

  Layout it creates (WinSW wants <id>.exe and <id>.xml side by side):
      C:\ProgramData\TasklyAI\ollama\ollama.exe / ollama.xml / logs\
      C:\ProgramData\TasklyAI\taskly-model-server\taskly-model-server.exe / .xml / logs\
      C:\ProgramData\TasklyAI\backup\   (tray auto-start + power-setting backups)
      C:\ProgramData\TasklyAI\_download\ (the verified WinSW exe, reused on re-run)

.PARAMETER RepoPath
  The Taskly repo root (default: two folders above this script).
.PARAMETER UserProfile
  The profile that owns the Ollama install and models (default: %USERPROFILE%).
.PARAMETER Port
  TCP port of the model server (default 8765).
.PARAMETER BindAddress
  Listen address of the model server (default 0.0.0.0, all interfaces).
.PARAMETER Translator
  Translator passed to the model server (default ollama).
.PARAMETER RequireGpu
  Pass --require-gpu so the server exits (and the service restarts it) when
  CUDA is not ready, instead of silently decoding on the CPU (default $true).
.PARAMETER OllamaExe
  Override the ollama.exe path (default: auto-detected).
.PARAMETER OllamaModels
  Override the Ollama models folder (default: <UserProfile>\.ollama\models).
.PARAMETER OllamaKeepAlive
  OLLAMA_KEEP_ALIVE for the Ollama service (default -1: keep loaded). Ollama's
  OpenAI-compatible endpoint (platforms' chat requests) can't ask for this
  itself, and each such request would otherwise reset the translator model to
  a 5-minute idle timeout, costing the next meeting line a cold load. Ollama
  still evicts an idle model when another one needs the VRAM.
.PARAMETER OllamaContextLength
  OLLAMA_CONTEXT_LENGTH (default 8192). The same model at a different context
  size is reloaded; the model server's translator and summaries use 8192
  (TASKLY_OLLAMA_NUM_CTX), and the OpenAI endpoint ignores num_ctx, so this
  makes every caller agree.
.PARAMETER WinSWPath
  An already-downloaded WinSW-x64.exe (v2.12.0). It is still hash-verified.
.PARAMETER WinSWSha256
  Expected SHA-256 of the WinSW exe. Defaults to the value pinned below.
.PARAMETER FirewallProfile
  Firewall profile(s) for the inbound rule (default Private).
.PARAMETER HealthTimeoutSec
  How long to wait for the model server's /v1/health (default 240; the first
  start loads Whisper onto the GPU and can take minutes).
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$RepoPath = $(if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path } else { 'C:\Users\Thouseef Purayil\Desktop\Taskly' }),
    [string]$UserProfile = $env:USERPROFILE,
    [int]$Port = 8765,
    [string]$BindAddress = '0.0.0.0',
    [string]$Translator = 'ollama',
    [bool]$RequireGpu = $true,
    [string]$OllamaExe = '',
    [string]$OllamaModels = '',
    [string]$OllamaKeepAlive = '-1',
    [int]$OllamaContextLength = 8192,
    [string]$WinSWPath = '',
    [string]$WinSWSha256 = '',
    [string]$FirewallProfile = 'Private',
    [int]$HealthTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pinned WinSW release. v2.12.0 is the latest STABLE release (v3 is alpha-only).
# WinSW-x64.exe is the self-contained build: it needs no .NET install on the PC.
#   size   : 18,243,033 bytes
#   SHA-256: GitHub's API publishes no asset digest for this 2023 release, so the
#            hash below comes from the Scoop "winsw" manifest (ScoopInstaller/Main,
#            bucket/winsw.json, 64bit hash for the same v2.12.0 URL). It is an
#            independent source, but it was NOT computed from the binary by the
#            author of this script. If it is ever wrong the script fails closed
#            (refuses to install). To re-pin: download once, check the hash
#            against a second source, then edit this constant.
#   If this value is not 64 hex characters the script refuses to proceed.
# ---------------------------------------------------------------------------
$WinSWVersion   = 'v2.12.0'
$WinSWAsset     = 'WinSW-x64.exe'
$WinSWUrl       = "https://github.com/winsw/winsw/releases/download/$WinSWVersion/$WinSWAsset"
$WinSWSize      = 18243033
$WinSWPinnedSha = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'   # source: Scoop winsw.json

$ServiceRoot = 'C:\ProgramData\TasklyAI'
$BackupDir   = Join-Path $ServiceRoot 'backup'
$ManifestFile = Join-Path $BackupDir 'pc-services-backup.json'
$DownloadDir = Join-Path $ServiceRoot '_download'
$FirewallRuleName = "Taskly model server (TCP $Port)"

$OllamaId = 'ollama'
$ModelServerId = 'taskly-model-server'

# ---- small helpers --------------------------------------------------------

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

function Test-Sha256Format([string]$Text) { return ($Text -match '^[0-9a-fA-F]{64}$') }

function XmlEscape([string]$Text) { return [System.Security.SecurityElement]::Escape($Text) }

function Invoke-Quiet {
    # Runs a native command, returns @{ Code = <exit code>; Output = <text> }.
    param([string]$File, [string[]]$Arguments)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # stderr lines must not throw
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
    # $true when a service with this name exists AND runs from our WinSW folder.
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Id'" -ErrorAction SilentlyContinue
    if (-not $svc) { return $false }
    return ([string]$svc.PathName).IndexOf($ServiceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-OurService([string]$Id) {
    # Stops one of OUR services (and anything depending on it). No-op if absent or stopped.
    $svc = Get-Service -Name $Id -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -eq 'Stopped') { return }
    Write-Info "Stopping $Id (and anything that depends on it)..."
    Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue
    try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90)) } catch { Write-Warn "$Id did not report Stopped in 90 s." }
}

function Remove-OurService([string]$Id) {
    # Stops and unregisters one of OUR services. No-op if absent.
    if (-not (Get-Service -Name $Id -ErrorAction SilentlyContinue)) { return }
    Stop-OurService $Id
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
        throw "Service '$Id' is still registered (marked for deletion?). Close services.msc / Task Manager and re-run."
    }
}

function Get-PowerAcMinutes([string]$SettingGuid) {
    # Current AC value of a SUB_SLEEP setting, in minutes (-1 = could not read).
    # Locale-proof: the AC index is the second-to-last 0x........ in the output.
    $r = Invoke-Quiet 'powercfg.exe' @('/query', 'SCHEME_CURRENT', '238c9fa8-0aad-41ed-83f4-97be242c8f20', $SettingGuid)
    if ($r.Code -ne 0) { return -1 }
    $hex = [regex]::Matches($r.Output, '0x[0-9a-fA-F]{8}')
    if ($hex.Count -lt 2) { return -1 }
    $seconds = [Convert]::ToInt64($hex[$hex.Count - 2].Value.Substring(2), 16)
    return [int][Math]::Round($seconds / 60.0)
}

function Format-Minutes([int]$Minutes) {
    if ($Minutes -lt 0) { return 'unknown' }
    if ($Minutes -eq 0) { return 'never' }
    return "$Minutes min"
}

# ---- backup manifest (shared with uninstall-pc-services.ps1) ---------------

function Read-Manifest {
    $m = @{ version = 1; startup = @(); run = @(); power = $null }
    if (Test-Path -LiteralPath $ManifestFile) {
        try {
            $old = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json
            if ($old.startup) { $m.startup = @($old.startup) }
            if ($old.run)     { $m.run     = @($old.run) }
            if ($old.power)   { $m.power   = $old.power }
        } catch {
            Write-Warn "Could not parse $ManifestFile ($($_.Exception.Message)); keeping a copy and starting a new one."
            Copy-Item -LiteralPath $ManifestFile -Destination "$ManifestFile.bad" -Force
        }
    }
    return $m
}

function Save-Manifest($Manifest) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $json = $Manifest | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($ManifestFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---- WinSW XML ------------------------------------------------------------

function New-WinSWXml {
    param(
        [string]$Id, [string]$Name, [string]$Description,
        [string]$Executable, [string]$Arguments, [string]$WorkingDirectory,
        [hashtable]$EnvVars, [string[]]$Depend
    )
    $e = New-Object System.Collections.Generic.List[string]
    $e.Add('<service>')
    $e.Add("  <id>$(XmlEscape $Id)</id>")
    $e.Add("  <name>$(XmlEscape $Name)</name>")
    $e.Add("  <description>$(XmlEscape $Description)</description>")
    $e.Add("  <executable>$(XmlEscape $Executable)</executable>")
    $e.Add("  <arguments>$(XmlEscape $Arguments)</arguments>")
    $e.Add("  <workingdirectory>$(XmlEscape $WorkingDirectory)</workingdirectory>")
    foreach ($key in ($EnvVars.Keys | Sort-Object)) {
        $e.Add("  <env name=`"$(XmlEscape $key)`" value=`"$(XmlEscape ([string]$EnvVars[$key]))`"/>")
    }
    foreach ($d in $Depend) { $e.Add("  <depend>$(XmlEscape $d)</depend>") }
    $e.Add('  <!-- start after the boot rush, with no sign-in needed (LocalSystem) -->')
    $e.Add('  <startmode>Automatic</startmode>')
    $e.Add('  <delayedAutoStart/>')
    $e.Add('  <!-- failure actions: the last one repeats forever, so restarts are unlimited -->')
    $e.Add('  <onfailure action="restart" delay="10 sec"/>')
    $e.Add('  <onfailure action="restart" delay="30 sec"/>')
    $e.Add('  <onfailure action="restart" delay="60 sec"/>')
    $e.Add('  <resetfailure>1 day</resetfailure>')
    $e.Add('  <stoptimeout>30 sec</stoptimeout>')
    $e.Add('  <logpath>%BASE%\logs</logpath>')
    $e.Add('  <log mode="roll-by-size">')
    $e.Add('    <sizeThreshold>10240</sizeThreshold>')   # KB per file (10 MB)
    $e.Add('    <keepFiles>8</keepFiles>')
    $e.Add('  </log>')
    $e.Add('</service>')
    return ($e -join "`r`n") + "`r`n"
}

function Install-WinSWService {
    param([string]$Id, [string]$Xml, [string]$ExeSource)
    $dir = Join-Path $ServiceRoot $Id
    Remove-OurService $Id                       # refresh = stop + unregister first
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'logs') | Out-Null
    Copy-Item -LiteralPath $ExeSource -Destination (Join-Path $dir "$Id.exe") -Force
    [System.IO.File]::WriteAllText((Join-Path $dir "$Id.xml"), $Xml, (New-Object System.Text.UTF8Encoding($false)))
    $r = Invoke-Quiet (Join-Path $dir "$Id.exe") @('install')
    if ($r.Code -ne 0) { throw "WinSW install of '$Id' failed (exit $($r.Code)): $($r.Output)" }
    # Count a non-zero exit of the wrapped process as a failure for the recovery actions.
    $null = Invoke-Quiet 'sc.exe' @('failureflag', $Id, '1')
    Write-Ok "Service '$Id' installed: $dir"
}

# ===========================================================================
# 0. Plan + sanity
# ===========================================================================

Write-Host ''
Write-Host 'Taskly PC services installer' -ForegroundColor White
Write-Host '(starts Ollama and the model server at boot, no sign-in needed)'

$EngineDir = Join-Path $RepoPath 'desktop-engine'
$PythonExe = Join-Path $EngineDir '.venv\Scripts\python.exe'
if (-not $OllamaModels) { $OllamaModels = Join-Path $UserProfile '.ollama\models' }
$KeyFile = Join-Path $EngineDir 'model-server.key'

# Find ollama.exe (per-user install first, then Program Files, then PATH).
if (-not $OllamaExe) {
    $candidates = @(
        (Join-Path $UserProfile 'AppData\Local\Programs\Ollama\ollama.exe'),
        (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { $OllamaExe = $c; break } }
    if (-not $OllamaExe) {
        $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
        if ($cmd) { $OllamaExe = $cmd.Source }
    }
}

$problems = New-Object System.Collections.Generic.List[string]
if (-not (Test-Path -LiteralPath $EngineDir)) { $problems.Add("desktop-engine folder not found: $EngineDir") }
if (-not (Test-Path -LiteralPath $PythonExe)) { $problems.Add("venv python not found: $PythonExe  (create it per desktop-engine\README.md)") }
if (-not $OllamaExe -or -not (Test-Path -LiteralPath $OllamaExe)) { $problems.Add('ollama.exe not found (pass -OllamaExe)') }
if (-not (Test-Path -LiteralPath $OllamaModels)) { Write-Warn "Models folder not found yet: $OllamaModels (the service would start with an empty library)." }
if ($Port -lt 1 -or $Port -gt 65535) { $problems.Add("invalid -Port $Port") }

# Resolve which SHA-256 we will enforce, and refuse to continue without one.
$ExpectedSha = $WinSWPinnedSha
if ($WinSWSha256) { $ExpectedSha = $WinSWSha256 }
if (-not (Test-Sha256Format $ExpectedSha)) {
    $problems.Add("No valid pinned SHA-256 for $WinSWAsset $WinSWVersion (got '$ExpectedSha'). Fill `$WinSWPinnedSha in this script (or pass -WinSWSha256) with the 64-hex hash.")
}
if ($problems.Count -gt 0) {
    Write-Host ''
    foreach ($p in $problems) { Write-Host "   [x] $p" -ForegroundColor Red }
    throw 'Fix the problems above and re-run. Nothing was changed.'
}
$ExpectedSha = $ExpectedSha.ToLowerInvariant()

Write-Step 'Plan'
Write-Info "Repo / engine     : $EngineDir"
Write-Info "Python (venv)     : $PythonExe"
Write-Info "Ollama            : $OllamaExe"
Write-Info "Ollama models     : $OllamaModels"
Write-Info "Model server      : ${BindAddress}:$Port  translator=$Translator  require-gpu=$RequireGpu"
Write-Info "WinSW             : $WinSWVersion $WinSWAsset (MIT), SHA-256 $ExpectedSha"
Write-Info "Services go in    : $ServiceRoot"
if ($env:USERPROFILE -ne $UserProfile) {
    Write-Warn "You are elevated as a different profile ($env:USERPROFILE) than -UserProfile; the tray auto-start tweaks below only cover Startup folders."
}
if (-not (Confirm-Action 'Continue with these settings? (nothing is changed until each step below is approved)')) {
    Write-Host 'Cancelled. Nothing was changed.'
    return
}

New-Item -ItemType Directory -Force -Path $ServiceRoot, $BackupDir | Out-Null
$manifest = Read-Manifest

# ===========================================================================
# 1. WinSW exe: given path, cached copy, or an asked-for download
# ===========================================================================

Write-Step "WinSW $WinSWVersion"
$WinSWExe = $null
$cached = Join-Path $DownloadDir "$WinSWAsset.$WinSWVersion"

function Test-WinSWFile([string]$Path) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    return @{ Ok = ($actual -eq $ExpectedSha); Actual = $actual }
}

if ($WinSWPath) {
    if (-not (Test-Path -LiteralPath $WinSWPath)) { throw "-WinSWPath not found: $WinSWPath" }
    $check = Test-WinSWFile $WinSWPath
    if (-not $check.Ok) { throw "SHA-256 of $WinSWPath is $($check.Actual) but the pinned value is $ExpectedSha. Refusing to use it." }
    $WinSWExe = $WinSWPath
    Write-Ok "Using $WinSWPath (SHA-256 verified)."
} elseif (Test-Path -LiteralPath $cached) {
    $check = Test-WinSWFile $cached
    if ($check.Ok) {
        $WinSWExe = $cached
        Write-Ok "Reusing the verified copy at $cached."
    } else {
        Write-Warn "Cached copy has the wrong hash ($($check.Actual)); deleting it."
        Remove-Item -LiteralPath $cached -Force
    }
}

if (-not $WinSWExe) {
    Write-Info 'WinSW wraps a program as a Windows service. It is not on this PC yet.'
    Write-Info "URL      : $WinSWUrl"
    Write-Info "File     : $WinSWAsset"
    Write-Info ("Size     : {0:N0} bytes (about {1:N1} MB)" -f $WinSWSize, ($WinSWSize / 1MB))
    Write-Info "SHA-256  : $ExpectedSha  (checked after download)"
    Write-Info 'Or answer no, download it yourself and re-run with -WinSWPath <file>.'
    if (-not (Confirm-Action 'Download it now?')) {
        Write-Host 'No download, no WinSW: nothing more to do. Nothing was installed.'
        return
    }
    New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
    $partial = "$cached.partial"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $savedProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'     # the 5.1 progress bar makes downloads very slow
    try {
        Invoke-WebRequest -Uri $WinSWUrl -OutFile $partial -UseBasicParsing
    } finally {
        $ProgressPreference = $savedProgress
    }
    $check = Test-WinSWFile $partial
    if (-not $check.Ok) {
        Remove-Item -LiteralPath $partial -Force
        throw "Downloaded file has SHA-256 $($check.Actual), expected $ExpectedSha. It was deleted; nothing was installed."
    }
    Move-Item -LiteralPath $partial -Destination $cached -Force
    $WinSWExe = $cached
    Write-Ok "Downloaded and verified: $cached"
}

# ===========================================================================
# 2. Services
# ===========================================================================

# ---- 2a. ollama -----------------------------------------------------------
Write-Step "Service '$OllamaId'  (ollama.exe serve on 127.0.0.1:11434)"
Write-Info 'Runs as LocalSystem at boot (delayed auto-start), restarts on failure (10 s, 30 s, then every 60 s).'
Write-Info "OLLAMA_MODELS=$OllamaModels so the service uses the models you already pulled."
$doOllama = $true
if (Get-Service -Name $OllamaId -ErrorAction SilentlyContinue) {
    if (-not (Test-OurService $OllamaId)) {
        Write-Warn "A service named '$OllamaId' already exists but is not ours (it does not run from $ServiceRoot). Not touching it."
        $doOllama = $false
    }
}
if ($doOllama -and (Confirm-Action "Install (or refresh) the '$OllamaId' service?")) {
    $ollamaEnv = @{
        'OLLAMA_HOST'       = '127.0.0.1:11434'
        'OLLAMA_MODELS'     = $OllamaModels
        'OLLAMA_KEEP_ALIVE' = $OllamaKeepAlive
        'OLLAMA_CONTEXT_LENGTH' = "$OllamaContextLength"
    }
    $xml = New-WinSWXml -Id $OllamaId -Name 'Ollama (Taskly PC)' `
        -Description 'Ollama model runtime for the Taskly GPU PC. Managed by install-pc-services.ps1.' `
        -Executable $OllamaExe -Arguments 'serve' -WorkingDirectory (Split-Path -Parent $OllamaExe) `
        -EnvVars $ollamaEnv -Depend @()
    Install-WinSWService -Id $OllamaId -Xml $xml -ExeSource $WinSWExe
}

# ---- 2b. taskly-model-server ----------------------------------------------
Write-Step "Service '$ModelServerId'  (python -m taskly_live serve ...)"
Write-Info "Depends on '$OllamaId'. Exits non-zero when the GPU is not ready, so restarts are unlimited (last delay repeats)."

$serveArgs = @('-m', 'taskly_live', 'serve')
$useGpuFlag = $RequireGpu
$skipModel = $false
if ($RequireGpu) {
    # An older checkout does not know --require-gpu: argparse would exit 2 forever.
    $help = Invoke-Quiet $PythonExe @('-m', 'taskly_live', 'serve', '--help')
    if ($help.Code -ne 0) {
        Write-Warn "Could not run '$PythonExe -m taskly_live serve --help' (exit $($help.Code)). Is the venv complete?"
        Write-Warn (($help.Output.Trim() -split "`r?`n" | Select-Object -First 3) -join ' | ')
    } elseif ($help.Output -notmatch '--require-gpu') {
        Write-Warn "This checkout's 'serve' does not list --require-gpu yet (update the repo). With the flag the service would crash-loop."
        if (Confirm-Action 'Install WITHOUT --require-gpu for now (the server may then decode on the CPU)?') {
            $useGpuFlag = $false
        } else {
            $skipModel = $true
        }
    }
}
if ($useGpuFlag) { $serveArgs += '--require-gpu' }
$serveArgs += @('--translator', $Translator, '--host', $BindAddress, '--port', [string]$Port)

$doModel = -not $skipModel
if ($doModel -and (Get-Service -Name $ModelServerId -ErrorAction SilentlyContinue)) {
    if (-not (Test-OurService $ModelServerId)) {
        Write-Warn "A service named '$ModelServerId' already exists but is not ours. Not touching it."
        $doModel = $false
    }
}
if ($doModel) {
    Write-Info ('Command: python.exe ' + ($serveArgs -join ' '))
    if (Confirm-Action "Install (or refresh) the '$ModelServerId' service?") {
        $modelEnv = @{
            'PYTHONUNBUFFERED'                = '1'
            'HF_HUB_DISABLE_SYMLINKS_WARNING' = '1'
            'TASKLY_DATA_DIR'                 = $EngineDir      # key, journal and models stay in desktop-engine
            'TASKLY_OLLAMA_URL'               = 'http://127.0.0.1:11434'
            'TASKLY_OLLAMA_NUM_CTX'           = "$OllamaContextLength"
        }
        $xml = New-WinSWXml -Id $ModelServerId -Name 'Taskly model server' `
            -Description 'Whisper + translation + summaries for Taskly laptops. Managed by install-pc-services.ps1.' `
            -Executable $PythonExe -Arguments ($serveArgs -join ' ') -WorkingDirectory $EngineDir `
            -EnvVars $modelEnv -Depend @($OllamaId)
        Install-WinSWService -Id $ModelServerId -Xml $xml -ExeSource $WinSWExe
    }
}

# ===========================================================================
# 3. Ollama tray app: stop it auto-starting at sign-in
# ===========================================================================

Write-Step 'Ollama tray app auto-start'
$startupDirs = @(
    (Join-Path $UserProfile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\StartUp')
)
$foundShortcuts = @()
foreach ($d in $startupDirs) {
    if (Test-Path -LiteralPath $d) {
        $foundShortcuts += @(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*ollama*' })
    }
}
$runKeys = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')
if ($env:USERPROFILE -eq $UserProfile) { $runKeys += 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }
$foundRun = @()
foreach ($k in $runKeys) {
    if (Test-Path -LiteralPath $k) {
        $item = Get-Item -LiteralPath $k
        foreach ($name in $item.GetValueNames()) {
            if ($name -like '*ollama*') {
                $foundRun += @(@{ key = $k; name = $name; value = [string]$item.GetValue($name) })
            }
        }
    }
}

if ($foundShortcuts.Count -eq 0 -and $foundRun.Count -eq 0) {
    Write-Info 'No Ollama entry in the Startup folders or Run keys (already removed, or never created).'
} else {
    foreach ($s in $foundShortcuts) { Write-Info "Startup shortcut : $($s.FullName)" }
    foreach ($r in $foundRun) { Write-Info "Run value        : $($r.key)\$($r.name) = $($r.value)" }
    Write-Info "They will be moved/saved under $BackupDir so uninstall can restore them."
    if (Confirm-Action 'Stop the Ollama tray app starting at sign-in?') {
        $stash = Join-Path $BackupDir 'startup'
        New-Item -ItemType Directory -Force -Path $stash | Out-Null
        foreach ($s in $foundShortcuts) {
            $dest = Join-Path $stash ('{0}_{1}' -f ([guid]::NewGuid().ToString('N').Substring(0, 8)), $s.Name)
            Move-Item -LiteralPath $s.FullName -Destination $dest
            $manifest.startup = @($manifest.startup) + @(@{ original = $s.FullName; backup = $dest })
            Write-Ok "Moved $($s.Name) to $dest"
        }
        foreach ($r in $foundRun) {
            $manifest.run = @($manifest.run) + @(@{ key = $r.key; name = $r.name; value = $r.value })
            Save-Manifest $manifest      # save BEFORE deleting the value
            Remove-ItemProperty -LiteralPath $r.key -Name $r.name
            Write-Ok "Removed Run value $($r.name) (saved in the backup file)"
        }
        Save-Manifest $manifest
    }
}

# ===========================================================================
# 4. Power plan
# ===========================================================================

Write-Step 'Power plan (AC power)'
$standbyGuid   = '29f6c1db-86da-48c5-9fdb-f2b67b1f44da'
$hibernateGuid = '9d7815a6-7ee4-497e-8888-515a05f02364'
$standbyNow   = Get-PowerAcMinutes $standbyGuid
$hibernateNow = Get-PowerAcMinutes $hibernateGuid
$hiberFileOn = $null
try {
    $val = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -Name HibernateEnabled -ErrorAction Stop).HibernateEnabled
    $hiberFileOn = ([int]$val -ne 0)
} catch { }
$hiberText = 'unknown'
if ($hiberFileOn -eq $true) { $hiberText = 'yes' } elseif ($hiberFileOn -eq $false) { $hiberText = 'no' }
Write-Info "Sleep after (plugged in)     : $(Format-Minutes $standbyNow)"
Write-Info "Hibernate after (plugged in) : $(Format-Minutes $hibernateNow)"
Write-Info "Hibernation file enabled     : $hiberText"

function Save-PowerBackupOnce {
    # Keep the FIRST values seen, so a re-run never overwrites the originals.
    if (-not $manifest.power) {
        $manifest.power = @{ standbyAcMinutes = $standbyNow; hibernateAcMinutes = $hibernateNow; hibernateFileWasOn = $hiberFileOn }
        Save-Manifest $manifest
    }
}

if ($standbyNow -eq 0 -and $hibernateNow -eq 0) {
    Write-Ok 'Already never sleeps or hibernates on AC power.'
} elseif (Confirm-Action 'Never sleep or hibernate while plugged in (a sleeping PC cannot serve models)?') {
    Save-PowerBackupOnce
    $a = Invoke-Quiet 'powercfg.exe' @('/change', 'standby-timeout-ac', '0')
    $b = Invoke-Quiet 'powercfg.exe' @('/change', 'hibernate-timeout-ac', '0')
    if ($a.Code -eq 0 -and $b.Code -eq 0) { Write-Ok 'standby-timeout-ac = 0, hibernate-timeout-ac = 0' }
    else { Write-Warn "powercfg returned $($a.Code)/$($b.Code): $($a.Output) $($b.Output)" }
}
if ($hiberFileOn -eq $false) {
    Write-Info 'Hibernation is already off.'
} elseif (Confirm-Action 'Also turn hibernation off completely (powercfg /hibernate off; this also disables Fast Startup, so a reboot is a real boot)?') {
    Save-PowerBackupOnce
    $h = Invoke-Quiet 'powercfg.exe' @('/hibernate', 'off')
    if ($h.Code -eq 0) { Write-Ok 'Hibernation off.' } else { Write-Warn "powercfg /hibernate off returned $($h.Code): $($h.Output)" }
}

# ===========================================================================
# 5. Firewall
# ===========================================================================

Write-Step "Firewall (inbound TCP $Port)"
Write-Info 'Windows only prompts to allow a program for interactive apps, never for services, so a rule is needed.'
try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop)
    foreach ($p in $profiles) { Write-Info ("Network '{0}' ({1}) is {2}" -f $p.Name, $p.InterfaceAlias, $p.NetworkCategory) }
    $ts = @($profiles | Where-Object { $_.InterfaceAlias -like '*Tailscale*' })
    if ($ts.Count -gt 0) { Write-Info "Tailscale's adapter is on the $($ts[0].NetworkCategory) profile; the rule below only covers it when that matches -FirewallProfile ($FirewallProfile)." }
    else { Write-Info "No Tailscale adapter seen. Tailscale's interface is usually its own network; check its profile if laptops cannot connect." }
} catch { Write-Info 'Could not read network profiles.' }
$existingRule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
if ($existingRule) { Write-Info "A rule named '$FirewallRuleName' exists; it will be replaced." }
if (Confirm-Action "Allow inbound TCP $Port on the $FirewallProfile profile?") {
    if ($existingRule) { Remove-NetFirewallRule -DisplayName $FirewallRuleName }
    $null = New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile $FirewallProfile `
        -Description 'Taskly model server for laptops (install-pc-services.ps1).'
    Write-Ok "Rule '$FirewallRuleName' added."
}

# ===========================================================================
# 6. Tailscale (check only)
# ===========================================================================

Write-Step 'Tailscale (check only, nothing is changed)'
$tsExe = $null
foreach ($c in @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'))) {
    if ($c -and (Test-Path -LiteralPath $c)) { $tsExe = $c; break }
}
if (-not $tsExe) { $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue; if ($cmd) { $tsExe = $cmd.Source } }
if (-not $tsExe) {
    Write-Warn 'Tailscale is not installed. Laptops reach this PC best over Tailscale: https://tailscale.com/download'
} else {
    Write-Ok "Found $tsExe"
    $tsSvc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    if ($tsSvc) { Write-Info "Tailscale service: $($tsSvc.Status), start type $($tsSvc.StartType)" }
    # 'Run unattended' is the ForceDaemon preference. 'tailscale debug prefs' prints the prefs as JSON.
    $force = $null
    try {
        $r = Invoke-Quiet $tsExe @('debug', 'prefs')
        if ($r.Code -eq 0) { $force = ($r.Output | ConvertFrom-Json).ForceDaemon }
    } catch { }
    if ($force -eq $true) {
        Write-Ok '"Run unattended" is ON (ForceDaemon = true): Tailscale stays connected with nobody signed in.'
    } elseif ($force -eq $false) {
        Write-Warn '"Run unattended" is OFF. After a reboot Tailscale only connects once someone signs in.'
        Write-Info 'Turn it on with:  tailscale set --unattended=true'
        Write-Info '   or GUI: tray icon > Preferences > Run unattended > Yes.'
    } else {
        Write-Warn 'Could not read the ForceDaemon preference (not signed in, or a different CLI version?).'
        Write-Info 'Check tray icon > Preferences > Run unattended, or set it:  tailscale set --unattended=true'
    }
}

# ===========================================================================
# 7. Start everything
# ===========================================================================

$haveOllamaSvc = $false
$haveModelSvc = $false
if ((Get-Service -Name $OllamaId -ErrorAction SilentlyContinue) -and (Test-OurService $OllamaId)) { $haveOllamaSvc = $true }
if ((Get-Service -Name $ModelServerId -ErrorAction SilentlyContinue) -and (Test-OurService $ModelServerId)) { $haveModelSvc = $true }

if (-not $haveOllamaSvc -and -not $haveModelSvc) {
    Write-Step 'Nothing to start'
    Write-Info 'No Taskly services are installed.'
    return
}

Write-Step 'Restarting services'
# Start from a clean stop: model server first (it depends on Ollama), then Ollama.
if ($haveModelSvc)  { Stop-OurService $ModelServerId }
if ($haveOllamaSvc) { Stop-OurService $OllamaId }

# A tray Ollama (or any other server on 11434) would fight the service for the port.
$trayProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'ollama app' -or $_.ProcessName -eq 'ollama' })
if ($haveOllamaSvc -and $trayProcs.Count -gt 0) {
    Write-Info 'Ollama processes still running outside the services (the tray app and its server):'
    foreach ($p in $trayProcs) { Write-Info ("  {0}  pid {1}  {2}" -f $p.ProcessName, $p.Id, $p.Path) }
    if (Confirm-Action 'Stop them now so the service owns port 11434? (loaded models are unloaded; the service reloads them on demand)') {
        # Stop the tray first or it respawns the server; then the server and its runners.
        Get-Process -Name 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 1
        Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'ollama' -or $_.ProcessName -like 'ollama_llama_server*' } | Stop-Process -Force
        Start-Sleep -Seconds 2
        Write-Ok 'Stopped.'
    }
}

$startOllama = $haveOllamaSvc
if ($haveOllamaSvc) {
    $owner = $null
    try {
        $conn = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
    } catch { }
    if ($owner) {
        Write-Warn "Port 11434 is held by $($owner.ProcessName) (pid $($owner.Id)). Not starting the '$OllamaId' service; stop that process, then run: Start-Service $OllamaId, $ModelServerId"
        $startOllama = $false
    }
}

if ($startOllama) {
    Start-Service -Name $OllamaId
    Write-Info 'Waiting for Ollama on http://127.0.0.1:11434 ...'
    $ok = $false
    for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
        try {
            $v = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 3
            $ok = $true
            Write-Ok "Ollama answers (version $($v.version))."
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ok) { Write-Warn "Ollama did not answer in 60 s. See $ServiceRoot\$OllamaId\logs" }
}

$startModel = $haveModelSvc
if ($haveModelSvc -and -not $startOllama -and -not (Get-Service -Name $OllamaId -ErrorAction SilentlyContinue)) {
    Write-Warn "'$ModelServerId' depends on the '$OllamaId' service, which is not installed; it will not start."
    $startModel = $false
}
if ($haveModelSvc -and -not $startOllama -and (Get-Service -Name $OllamaId -ErrorAction SilentlyContinue)) {
    Write-Warn "Not starting '$ModelServerId' because '$OllamaId' was not started (see above)."
    $startModel = $false
}
if ($startModel) {
    Start-Service -Name $ModelServerId
    Write-Info "Waiting up to $HealthTimeoutSec s for http://127.0.0.1:$Port/v1/health (the first start loads Whisper onto the GPU) ..."
    $healthUrl = "http://127.0.0.1:$Port/v1/health"
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $health = $null
    while ((Get-Date) -lt $deadline -and -not $health) {
        try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 } catch { Start-Sleep -Seconds 3 }
    }
    if ($health) {
        Write-Ok 'Model server is up. /v1/health (no key):'
        Write-Host ('   ' + ($health | ConvertTo-Json -Compress))
        # With the server key the health reply also names the device. Read the key file
        # here, send it, and never print it.
        if (Test-Path -LiteralPath $KeyFile) {
            $key = (Get-Content -LiteralPath $KeyFile -TotalCount 1).Trim()
            if ($key) {
                try {
                    $detail = Invoke-RestMethod -Uri $healthUrl -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 5
                    Write-Host ('   with key: ' + ($detail | ConvertTo-Json -Compress))
                    if ("$($detail.device)" -like 'cuda*') { Write-Ok 'device = cuda: the GPU works from the service (session 0).' }
                    else { Write-Warn "device = '$($detail.device)': NOT on the GPU. Check the logs and the NVIDIA driver." }
                } catch { Write-Warn "Health with the key failed: $($_.Exception.Message)" }
            }
        }
    } else {
        Write-Warn "No answer from $healthUrl within $HealthTimeoutSec s. The service may be restarting (for example the GPU is not ready)."
        Write-Info "Look at the logs below. 'Get-Service $ModelServerId' shows its state."
    }
}

# ===========================================================================
# 8. Summary
# ===========================================================================

Write-Step 'Done'
Write-Info "Services : Get-Service $OllamaId, $ModelServerId     (services.msc: 'Ollama (Taskly PC)', 'Taskly model server')"
Write-Info "Logs     : $ServiceRoot\$OllamaId\logs\   and   $ServiceRoot\$ModelServerId\logs\"
Write-Info '           (<id>.out.log, <id>.err.log, <id>.wrapper.log; rolled at 10 MB, 8 files kept)'
Write-Info "Key      : $KeyFile   (never printed here)"
Write-Info 'Check CUDA from the service (session 0): call health WITH the server key and look for "device": "cuda":'
Write-Info "   curl.exe -H `"Authorization: Bearer <key>`" http://127.0.0.1:$Port/v1/health"
Write-Info '   <key> = a platform key: & $PythonExe -m taskly_live serve keys add <name> (run in the desktop-engine folder).'
Write-Info 'Reboot test: restart the PC and do NOT sign in; from a laptop, GET /v1/health should answer within a few minutes (delayed start).'
Write-Info 'Remove everything with: uninstall-pc-services.ps1 (same folder).'
