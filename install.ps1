# Install dsh-archive-manager into the web profile.
# Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1
# Compatible with BOTH Windows PowerShell 5.1 and PowerShell 7.
#
# IMPORTANT FIX: the previous version used `Set-Content -Encoding UTF8`,
# which on Windows PowerShell 5.1 writes a UTF-8 BOM. Node's JSON.parse
# rejects that ("Unexpected token '\uFEFF'"), breaking `dsh web` boot.
# This version reads/writes package.json through .NET APIs that produce
# BOM-less UTF-8 on every PowerShell edition and verifies the written
# JSON with Node itself before reporting success.

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Locate the web profile -------------------------------------------------
$profileDir = $null
if ($env:DSH_HOME) {
    $candidate = Join-Path $env:DSH_HOME 'profiles\web'
    if (Test-Path $candidate) { $profileDir = $candidate }
}
if (-not $profileDir) {
    $candidate = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'profiles\web'
    if (Test-Path $candidate) { $profileDir = $candidate }
}
if (-not $profileDir) { throw "web profile not found (checked DSH_HOME=$env:DSH_HOME and default home)" }

Write-Host "Installing dsh-archive-manager -> $profileDir"

# --- BOM-less text helpers (PS 5.1 + 7 safe) --------------------------------
function Read-TextFile($path) {
    # StreamReader auto-detects and strips any BOM when reading.
    $reader = New-Object System.IO.StreamReader($path, [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Write-TextFile($path, $content) {
    # UTF8Encoding($false) = no BOM, guaranteed on both PowerShell editions.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

# --- 1. Copy the package into the profile's node_modules --------------------
$target = Join-Path $profileDir "node_modules\dsh-archive-manager"
$targetTemp = Join-Path $profileDir "node_modules\.dsh-archive-manager-install"
if (Test-Path $targetTemp) { Remove-Item -Recurse -Force $targetTemp }
New-Item -ItemType Directory -Force -Path $targetTemp | Out-Null
Copy-Item -Path "$pluginDir\*" -Destination $targetTemp -Recurse -Force
# The installer itself is a tool, not a shipped plugin part.
Remove-Item -Path (Join-Path $targetTemp 'install.ps1') -Force -ErrorAction SilentlyContinue
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Move-Item -Path $targetTemp -Destination $target
Write-Host "  copied to $target"

# --- 2. Register dependency + bundle in the profile manifest ----------------
$pkgPath = Join-Path $profileDir 'package.json'
$raw = Read-TextFile $pkgPath
if (-not $raw.Trim().StartsWith('{')) {
    throw "package.json does not look like JSON at $pkgPath (first chars: $($raw.Substring(0, [Math]::Min(40, $raw.Length))))"
}

# Back up the manifest once, so an unexpected edit is recoverable.
$backupPath = Join-Path $profileDir 'package.json.dsh-archive-manager.bak'
if (-not (Test-Path $backupPath)) { Write-TextFile $backupPath $raw }

$pkg = $raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([ordered]@{}) -Force }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile.bundles = @() }
if (-not $pkg.dependencies.'dsh-archive-manager') {
    $pkg.dependencies | Add-Member -NotePropertyName 'dsh-archive-manager' -NotePropertyValue '0.1.0' -Force
}
if ($pkg.dsh.profile.bundles -notcontains 'dsh-archive-manager') {
    $pkg.dsh.profile.bundles += 'dsh-archive-manager'
}
$json = $pkg | ConvertTo-Json -Depth 20
Write-TextFile $pkgPath $json
Write-Host "  updated $pkgPath"

# --- 3. Verify with Node itself: valid JSON, no BOM, entries present --------
$verify = "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);if(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF){throw new Error('BOM left in file')}const j=JSON.parse(b.toString('utf8'));if(!j.dependencies||!j.dependencies['dsh-archive-manager'])throw new Error('dependency missing');if(!j.dsh||!j.dsh.profile||!j.dsh.profile.bundles||!j.dsh.profile.bundles.includes('dsh-archive-manager'))throw new Error('bundle missing');console.log('package.json verified (no BOM, JSON valid, plugin registered)');"
$verifyResult = & node -e $verify $pkgPath 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  verification failed: $verifyResult"
    if (Test-Path $backupPath) {
        Write-Host "  restoring backup from $backupPath"
        Write-TextFile $pkgPath (Read-TextFile $backupPath)
    }
    throw "package.json verification failed; original restored. See message above."
}
Write-Host "  $verifyResult"

Write-Host "`nDone. Restart dsh web (host half) and refresh the page (browser half):"
Write-Host "  dsh web"