# FluxAgent - Windows PowerShell installer.
#
# One-line install (run in PowerShell):
#
#   irm https://raw.githubusercontent.com/Ahaduzzamankhan/fluxagent/main/install.ps1 | iex
#
# What it does:
#   1. Verifies Node.js 22.6+ is installed (gives a download link if not).
#   2. Downloads the FluxAgent source from GitHub into $env:USERPROFILE\.fluxagent\app.
#   3. Creates fluxagent.cmd and fluxagent.ps1 shims in $env:USERPROFILE\.fluxagent\bin.
#   4. Adds that bin directory to the user PATH.
#   5. Verifies `fluxagent doctor` runs.
#
# After this, from any terminal:  fluxagent chat

$ErrorActionPreference = "Stop"

$Repo     = "https://github.com/Ahaduzzamankhan/fluxagent"
$Tarball  = "$Repo/archive/refs/heads/main.tar.gz"
$InstallRoot = Join-Path $env:USERPROFILE ".fluxagent"
$AppDir   = Join-Path $InstallRoot "app"
$BinDir   = Join-Path $InstallRoot "bin"

function Say($msg)  { Write-Host "fluxagent: $msg" }
function Die($msg)  { Write-Host "fluxagent: ERROR: $msg" -ForegroundColor Red; exit 1 }

# ── 1. Node.js check ─────────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Die "Node.js is not installed. Install Node 22.6+ from https://nodejs.org and re-run this installer."
}
$nodeVersion = (node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
$nodeMinor = [int]($nodeVersion -split '\.')[1]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 6)) {
    Die "Node.js $nodeVersion found but FluxAgent needs 22.6+. Update from https://nodejs.org"
}
Say "Node.js v$nodeVersion found."

# ── 2. Download source ───────────────────────────────────────────────────────
Say "Downloading FluxAgent from GitHub..."
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
$tmpTar = Join-Path $env:TEMP "fluxagent-main.tar.gz"

try {
    Invoke-WebRequest -Uri $Tarball -OutFile $tmpTar -UseBasicParsing
} catch {
    Die "download failed: $($_.Exception.Message)"
}

# Windows 10+ ships bsdtar as tar.exe - extracts .tar.gz natively.
$tarExe = Get-Command tar -ErrorAction SilentlyContinue
if (-not $tarExe) { Die "tar.exe not found (needs Windows 10 1803+)." }

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
# Use the Windows-native tar (bsdtar, ships with Win10 1803+). The Git-bash
# tar on PATH misinterprets "C:\..." paths as remote hosts, so pin the
# system one explicitly.
$tarExe = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path $tarExe)) { $tarExe = "tar" }
& $tarExe -xzf $tmpTar -C $AppDir --strip-components 1
if ($LASTEXITCODE -ne 0) { Die "extraction failed (tar exit $LASTEXITCODE)." }
Remove-Item -Force $tmpTar
if (-not (Test-Path (Join-Path $AppDir "src\cli\index.ts"))) {
    Die "downloaded archive looks wrong (src/cli/index.ts missing)."
}
Say "Source installed at $AppDir"

# ── 3. Shims ─────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$ps1Shim = Join-Path $BinDir "fluxagent.ps1"
@"
#!/usr/bin/env pwsh
# FluxAgent CLI shim - forwards everything to the real CLI.
& node --experimental-strip-types "$AppDir\src\cli\index.ts" @args
exit $LASTEXITCODE
"@ | Set-Content -Path $ps1Shim -Encoding UTF8

$cmdShim = Join-Path $BinDir "fluxagent.cmd"
@"
@echo off
node --experimental-strip-types "$AppDir\src\cli\index.ts" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -Path $cmdShim -Encoding ASCII

Say "Shims created: $ps1Shim, $cmdShim"

# ── 4. PATH ──────────────────────────────────────────────────────────────────
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
    $env:Path += ";$BinDir"
    Say "Added $BinDir to your user PATH."
} else {
    Say "PATH already contains $BinDir."
}

# ── 5. Verify ────────────────────────────────────────────────────────────────
Say "Verifying installation..."
$verify = & $ps1Shim version 2>&1
if ($LASTEXITCODE -eq 0) {
    Say "Install complete! Open a NEW terminal and run:"
    Write-Host ""
    Write-Host "    fluxagent doctor" -ForegroundColor Green
    Write-Host "    fluxagent chat" -ForegroundColor Green
    Write-Host ""
    Write-Host "Set a provider key first, e.g.:  " -NoNewline
    Write-Host "setx OPENAI_API_KEY sk-..." -ForegroundColor Yellow
    Write-Host "  (or ANTHROPIC_API_KEY, or OLLAMA_HOST=127.0.0.1:11434 for local models)"
} else {
    Die "verification failed. Run '$ps1Shim version' to see the error."
}
