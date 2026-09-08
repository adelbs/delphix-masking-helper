# Delphix Masking Helper — installer, updater and uninstaller for Windows.
#
#   irm https://adelbs.github.io/delphix-masking-helper/install.ps1 | iex
#
# Or, to read it before running it:
#
#   irm https://adelbs.github.io/delphix-masking-helper/install.ps1 -OutFile install.ps1
#   notepad install.ps1 ; .\install.ps1
#
# It only ever touches its own install directory and a launcher in %LOCALAPPDATA%\Programs\bin.
# Node, Java and git are checked, never installed: this will not change your toolchain.
#
# The Delphix libraries are licensed and cannot be downloaded by anything — the app itself
# explains how to supply them on first run.

$ErrorActionPreference = 'Stop'

$RepoUrl    = if ($env:DLPX_REPO_URL) { $env:DLPX_REPO_URL } else { 'https://github.com/adelbs/delphix-masking-helper.git' }
# Pins the install to one ref. Empty means "the newest release", resolved from the remote.
$DlpxRef    = if ($env:DLPX_REF) { $env:DLPX_REF } else { '' }
$DefaultDir = Join-Path $HOME 'delphix-masking-helper'
$BinDir     = Join-Path $env:LOCALAPPDATA 'Programs\bin'
$Launcher   = Join-Path $BinDir 'dlpx-helper.cmd'
$NodeMin    = 22
$JavaMin    = 11

function Say  { param($m) Write-Host $m }
function Step { param($m) Write-Host ""; Write-Host "==> $m" -ForegroundColor White }
function Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host ""; Write-Host "error: $m" -ForegroundColor Red; exit 1 }

function Ask {
    param($Prompt, $Default = '')
    $a = Read-Host $Prompt
    if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
    return $a
}

# The newest release tag, read straight from the remote - so cutting a release needs no edit
# here. Deliberately git and not the GitHub releases API: git is already a hard requirement, it
# keeps working for forks and non-GitHub remotes that DLPX_REPO_URL points at, and it has no
# unauthenticated rate limit to trip over. Only vMAJOR.MINOR.PATCH counts, so a pre-release tag
# (v2.0.0-rc1) is never picked up by someone running the plain one-liner.
function Get-LatestRef {
    try {
        $tags = @(git ls-remote --tags --refs $RepoUrl 2>$null |
            ForEach-Object { ($_ -split '\s+')[1] -replace '^refs/tags/', '' } |
            Where-Object { $_ -match '^v\d+\.\d+\.\d+$' })
    } catch { return '' }
    if (-not $tags) { return '' }
    # [version] sorts by field, which is what makes v1.10.0 newer than v1.9.0.
    return ($tags | Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1)
}

# Empty output means "no release to track" - a fork that has never tagged, or an unreachable
# remote. Callers fall back to the default branch rather than refusing to install.
function Resolve-Ref {
    if ($DlpxRef) { return $DlpxRef }
    return Get-LatestRef
}

function Confirm {
    param($Prompt)
    $a = Read-Host "$Prompt [y/N]"
    return $a -match '^(y|yes)$'
}

# ── prerequisites ────────────────────────────────────────────────────────────

function Test-Prereqs {
    Step "Checking what is already on this machine"
    $missing = $false

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $v = [int]((node -v) -replace '^v','' -split '\.')[0]
        if ($v -ge $NodeMin) { Ok "Node $(node -v)" }
        else { Warn "Node $(node -v) is too old - $NodeMin or newer is required."; Say "        winget install OpenJS.NodeJS.LTS"; $missing = $true }
    } else {
        Warn "Node is not installed ($NodeMin or newer)."; Say "        winget install OpenJS.NodeJS.LTS"; $missing = $true
    }

    $java = Get-Command java -ErrorAction SilentlyContinue
    if ($java) {
        $line = (java -version 2>&1 | Select-Object -First 1)
        if ($line -match '"(\d+)') {
            $jv = [int]$Matches[1]
            if ($jv -ge $JavaMin) { Ok "Java $jv" }
            else { Warn "Java $jv is too old - $JavaMin or newer is required."; Say "        winget install EclipseAdoptium.Temurin.21.JDK"; $missing = $true }
        } else { Warn "Could not read the Java version."; $missing = $true }
    } else {
        Warn "Java is not installed ($JavaMin or newer)."; Say "        winget install EclipseAdoptium.Temurin.21.JDK"; $missing = $true
    }

    if (Get-Command git -ErrorAction SilentlyContinue) { Ok "git $((git --version) -split ' ' | Select-Object -Last 1)" }
    else { Warn "git is not installed."; Say "        winget install Git.Git"; $missing = $true }

    if ($missing) { Die "Install what is missing above, then run this again. Nothing was changed." }
}

# ── launcher ─────────────────────────────────────────────────────────────────

function Write-Launcher {
    param($Dir)
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

    # A .cmd shim so it works from cmd.exe and PowerShell alike; the logic lives in the .ps1
    # beside it, which keeps quoting sane.
    $shim = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0dlpx-helper.ps1`" %*`r`n"
    Set-Content -Path $Launcher -Value $shim -Encoding ASCII -NoNewline

    $body = @'
param([string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$AppDir  = '__APP_DIR__'
$PidFile = Join-Path $AppDir '.dlpx-helper.pid'
$LogFile = Join-Path $AppDir '.dlpx-helper.log'
$Port    = if ($env:PORT) { $env:PORT } else { '3000' }
$Url     = "http://localhost:$Port"

function Get-Running {
    if (-not (Test-Path $PidFile)) { return $null }
    $p = Get-Content $PidFile | Select-Object -First 1
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) { return $proc } else { return $null }
}

function Start-App {
    if (Get-Running) { Write-Host "Already running at $Url"; Start-Process $Url; return }
    Push-Location $AppDir
    # Built at install and update time, not on every start.
    if (-not (Test-Path (Join-Path $AppDir 'frontend\dist'))) { npm run build --silent }
    # node directly, not `npm start`: npm would sit between us and the server, and the recorded
    # process id would be npm's, so stopping it would leave the server holding the port.
    $env:PORT = $Port
    $proc = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $AppDir `
        -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $proc.Id
    Pop-Location
    Write-Host -NoNewline 'Starting'
    foreach ($i in 1..60) {
        try { Invoke-WebRequest -Uri "$Url/" -UseBasicParsing -TimeoutSec 2 | Out-Null
              Write-Host ''; Write-Host "Running at $Url"; Start-Process $Url; return } catch {}
        if (-not (Get-Running)) { Write-Host ''; Write-Host 'It stopped on startup:'; Get-Content $LogFile -Tail 20; exit 1 }
        Write-Host -NoNewline '.'; Start-Sleep -Seconds 1
    }
    Write-Host ''; Write-Host "No answer after 60s. Last lines of ${LogFile}:"; Get-Content $LogFile -Tail 20; exit 1
}

function Stop-App {
    $proc = Get-Running
    if (-not $proc) { Write-Host 'Not running.'; Remove-Item $PidFile -ErrorAction SilentlyContinue; return }
    Stop-Process -Id $proc.Id -Force
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host 'Stopped.'
}

switch ($Action) {
    'start'     { Start-App }
    'stop'      { Stop-App }
    'restart'   { Stop-App; Start-App }
    'status'    { if (Get-Running) { Write-Host "Running at $Url" } else { Write-Host 'Not running.' } }
    'logs'      { Get-Content $LogFile -Tail 40 -Wait }
    'update'    { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'install.ps1') -Update }
    'uninstall' { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'install.ps1') -Uninstall }
    default     { Write-Host 'usage: dlpx-helper [start|stop|restart|status|logs|update|uninstall]'; exit 2 }
}
'@
    # Placeholder rather than interpolation: the body is a literal here-string so nothing inside
    # it expands, which is what keeps every $ in the launcher intact.
    $body = $body -replace '__APP_DIR__', $Dir.Replace("'", "''")
    Set-Content -Path (Join-Path $BinDir 'dlpx-helper.ps1') -Value $body -Encoding UTF8
    Ok "Command installed: $Launcher"
}

function Add-ToPath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -split ';' -contains $BinDir) { Ok "$BinDir is already on your PATH." ; return }
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
    Ok "Added $BinDir to your PATH (open a new terminal for it to take effect)."
}

function New-Shortcut {
    param($Dir)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnk = Join-Path $desktop 'Delphix Masking Helper.lnk'
        $ws = New-Object -ComObject WScript.Shell
        $s = $ws.CreateShortcut($lnk)
        $s.TargetPath = $Launcher
        $s.WorkingDirectory = $Dir
        $s.Description = 'Delphix Masking Helper'
        $s.Save()
        Ok "Desktop shortcut created."
    } catch { Warn "Could not create the desktop shortcut: $_" }
}

# ── actions ──────────────────────────────────────────────────────────────────

function Get-InstallDir {
    $ps1 = Join-Path $BinDir 'dlpx-helper.ps1'
    if (Test-Path $ps1) {
        $line = Select-String -Path $ps1 -Pattern "^\`$AppDir\s*=\s*'(.*)'$" | Select-Object -First 1
        if ($line) { return $line.Matches[0].Groups[1].Value }
    }
    return $DefaultDir
}

function Invoke-Build {
    param($Dir)
    Step "Installing dependencies"
    Push-Location $Dir
    # --omit=dev at the root: its devDependencies are the maintainer's tools (the demo recorder
    # pulls puppeteer-core) and none are needed to build or run the app. The frontend keeps its
    # dev dependencies - vite and typescript are what build it.
    npm install --silent --no-audit --no-fund --omit=dev
    npm install --silent --no-audit --no-fund --prefix frontend
    Ok "Dependencies installed"
    Step "Building"
    npm run build --silent
    Pop-Location
    Ok "Built"
}

function Invoke-Install {
    Test-Prereqs
    Step "Where should it be installed?"
    $dir = Ask "  Directory [$DefaultDir]" $DefaultDir

    if (Test-Path (Join-Path $dir '.git')) {
        Warn "There is already an install at $dir."
        if (Confirm "  Update it instead?") { Invoke-Update $dir; return }
        Die "Nothing was changed."
    }
    if ((Test-Path $dir) -and (Get-ChildItem $dir -Force | Measure-Object).Count -gt 0) {
        Die "$dir exists and is not empty."
    }

    Step "Downloading"
    $ref = Resolve-Ref
    if ($ref) {
        # A release is checked out detached by definition; git's advice about that is noise here.
        git -c advice.detachedHead=false clone --quiet --depth 1 --branch $ref $RepoUrl $dir
        if ($LASTEXITCODE -ne 0) { Die "Could not clone $ref from $RepoUrl." }
        Ok "Cloned $ref into $dir"
    } else {
        # No tag to track: better a working install off the default branch than none at all.
        git clone --quiet --depth 1 $RepoUrl $dir
        if ($LASTEXITCODE -ne 0) { Die "Could not clone $RepoUrl." }
        Warn "No release tag found - installed the default branch instead."
    }

    Invoke-Build $dir
    Write-Launcher $dir
    Add-ToPath
    if (Confirm "  Create a desktop shortcut?") { New-Shortcut $dir }
    Show-Finish $dir
}

function Invoke-Update {
    param($Dir = '')
    if (-not $Dir) { $Dir = Get-InstallDir }
    if (-not (Test-Path (Join-Path $Dir '.git'))) { Die "No install found. Run without -Update to install." }

    Step "Updating $Dir"
    $before = (git -C $Dir rev-parse --short HEAD)
    $ref = Resolve-Ref

    if ($ref) {
        # Fetching the one tag keeps the clone shallow. It is allowed to fail - an install that
        # already has the tag is still fine to move onto, and only a missing ref is fatal.
        # $($ref) and not $ref: a colon straight after a variable name is a drive qualifier.
        git -C $Dir fetch --quiet --depth 1 origin "refs/tags/$($ref):refs/tags/$($ref)" 2>$null
        git -C $Dir rev-parse -q --verify "refs/tags/$ref" > $null 2>&1
        if ($LASTEXITCODE -ne 0) { Die "Could not fetch $ref from $RepoUrl." }
        # --detach because a release is a point, not a branch to accumulate commits on. Installs
        # made before this script tracked releases sit on the default branch; this is what moves
        # them across, and from then on every update is release to release.
        git -C $Dir -c advice.detachedHead=false checkout --quiet --detach $ref
        if ($LASTEXITCODE -ne 0) { Die "Could not switch to $ref - the install has local changes." }
    } else {
        Warn "No release tag found - following the default branch."
        git -C $Dir pull --quiet --ff-only
        if ($LASTEXITCODE -ne 0) { Die "Could not fast-forward - the install has local changes." }
    }

    $after = (git -C $Dir rev-parse --short HEAD)
    $suffix = if ($ref) { " ($ref)" } else { '' }
    if ($before -eq $after) { Ok "Already up to date$suffix." } else { Ok "Updated $before -> $after$suffix" }

    Invoke-Build $Dir
    Write-Launcher $Dir
    Say ""
    Ok "Your saved algorithms and settings were untouched - they live in $Dir\db\."
    Say "  Restart it with: dlpx-helper restart"
}

function Invoke-Uninstall {
    param($Dir = '')
    if (-not $Dir) { $Dir = Get-InstallDir }
    if (-not (Test-Path $Dir)) { Die "No install found." }

    Step "Uninstalling $Dir"
    Say ""
    Say "  This removes everything, including your saved algorithms and settings."
    Say "  They live in $Dir\db\ and cannot be recovered afterwards."
    Say ""
    Say "  If you want to keep them, stop now and use Export in the app"
    Say "  (Saved Tests/Algorithms -> Export) to save them to a file first."
    Say ""
    if (-not (Confirm "  Delete $Dir and the dlpx-helper command?")) { Say "  Nothing was removed."; return }

    if (Test-Path $Launcher) { & $Launcher stop 2>$null }
    Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
    Remove-Item -Force $Launcher, (Join-Path $BinDir 'dlpx-helper.ps1') -ErrorAction SilentlyContinue
    Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Delphix Masking Helper.lnk') -ErrorAction SilentlyContinue
    Ok "Removed."
}

function Show-Finish {
    param($Dir)
    Step "Done"
    Say ""
    Say "  Start it with:  dlpx-helper"
    Say ""
    Say "  One step left: the masking algorithms come from Delphix product files that"
    Say "  cannot be distributed. Copy the jars from your Masking Devkit (SDK) into:"
    Say ""
    Say "      $Dir\lib\"
    Say ""
    Say "  The app lists exactly which files it needs when you open it."
}

# ── entry ────────────────────────────────────────────────────────────────────

# A param() block would have to be the first statement in the file, before the functions, so
# the two flags are read from $args instead.
if ($args -contains '-Update')    { Invoke-Update; exit }
if ($args -contains '-Uninstall') { Invoke-Uninstall; exit }

Say "Delphix Masking Helper"
Say "An independent open source project. Requires an active Delphix licence."
$existing = Get-InstallDir
if ((Test-Path (Join-Path $existing '.git')) -and (Test-Path $Launcher)) {
    Say ""
    Say "  An install was found at $existing."
    $choice = Ask "  [u]pdate, [r]emove, or [q]uit? [u]" 'u'
    switch -Regex ($choice) {
        '^[uU]' { Invoke-Update }
        '^[rR]' { Invoke-Uninstall }
        default { Say "  Nothing was changed." }
    }
} else {
    Invoke-Install
}
