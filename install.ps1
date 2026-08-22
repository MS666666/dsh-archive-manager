<#
.SYNOPSIS
  Install dsh-archive-manager into a DeepSeek Harness web profile.

.DESCRIPTION
  Placeless one-shot installer. Run it from anywhere: the plugin root is
  resolved from this script's own location, the target profile is located
  through -ProfileDir (highest priority), then $env:DSH_HOME, then -DSHHome,
  then the default ~/.dsh. It copies only the shipped files (whitelist:
  lib/, client/, cordis.patch.yml, LICENSE, README.md, package.json) into the
  profile's node_modules, registers the dependency and bundle in the profile
  manifest using the plugin's OWN version, and verifies the written JSON
  with Node itself (no BOM, valid JSON, entries present) before reporting
  success. The first run keeps a backup at package.json.dsh-archive-manager.bak;
  a failed verify restores it automatically.

  Compatible with Windows PowerShell 5.1 and PowerShell 7: all profile JSON
  reads/writes go through .NET StreamReader/WriteAllText so no UTF-8 BOM is
  ever written (Node's JSON.parse rejects BOMs).

.PARAMETER ProfileDir
  Explicit profile directory, e.g. D:\deepseek-harness\.dsh\profiles\web.
  Highest priority; skips all home resolution when provided.

.PARAMETER ProfileName
  Profile to install into. Default "web".

.PARAMETER DSHHome
  DSH home directory, overriding $env:DSH_HOME when that is not set.

.PARAMETER DryRun
  Print every action without writing or copying anything.

.PARAMETER SkipCopy
  Skip the file copy and only update the profile manifest (re-runs).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DSHHome D:\deepseek-harness\.dsh
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$ProfileDir,
    [string]$ProfileName = 'web',
    [string]$DSHHome,
    [switch]$DryRun,
    [switch]$SkipCopy
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 0a. BOM-less text helpers (PS 5.1 + 7 safe). Defined before first use so
#     every JSON read/write in this script goes through the same code path.
# ---------------------------------------------------------------------------
function Read-TextFile($path) {
    $reader = New-Object System.IO.StreamReader($path, [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Write-TextFile($path, $content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}
function Log($message) {
    Write-Host "  $message"
}

# ---------------------------------------------------------------------------
# 0. Resolve the plugin root from this script's own path (placeless).
# ---------------------------------------------------------------------------
$PluginRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($PluginRoot) -or -not (Test-Path (Join-Path $PluginRoot 'package.json'))) {
    throw "install.ps1 must stay inside the plugin root (package.json not found next to it: $PluginRoot)"
}
$PluginManifest = Join-Path $PluginRoot 'package.json'
$PluginPkg = Read-TextFile $PluginManifest | ConvertFrom-Json
$PluginName = [string]$PluginPkg.name
$PluginVersion = [string]$PluginPkg.version
if ([string]::IsNullOrWhiteSpace($PluginName) -or [string]::IsNullOrWhiteSpace($PluginVersion)) {
    throw "plugin package.json must declare name and version"
}

# ---------------------------------------------------------------------------
# 2. Resolve the target profile directory.
# ---------------------------------------------------------------------------
$profile = $null
if ($ProfileDir) {
    $profile = $ProfileDir
}
else {
    $homeCandidates = @()
    if ($env:DSH_HOME) { $homeCandidates += (Join-Path $env:DSH_HOME "profiles\$ProfileName") }
    if ($DSHHome) { $homeCandidates += (Join-Path $DSHHome "profiles\$ProfileName") }
    $homeCandidates += (Join-Path (Join-Path $env:USERPROFILE '.dsh') "profiles\$ProfileName")
    foreach ($candidate in $homeCandidates) {
        if (Test-Path $candidate) { $profile = $candidate; break }
    }
}
if (-not $profile -or -not (Test-Path $profile)) {
    throw "profile not found. Provided -ProfileDir=$ProfileDir; tried: $($homeCandidates -join '; ')"
}

Write-Host "Installing $PluginName@$PluginVersion -> $profile"

# ---------------------------------------------------------------------------
# 3. Copy the shipped files (whitelist only) into the profile's node_modules.
# ---------------------------------------------------------------------------
$target = Join-Path $profile "node_modules\$PluginName"
if (-not $DryRun -and -not $SkipCopy) {
    $shipped = @('lib', 'client', 'cordis.patch.yml', 'LICENSE', 'README.md', 'package.json')
    $targetTemp = Join-Path $profile "node_modules\.$PluginName-install"
    if (Test-Path $targetTemp) { Remove-Item -Recurse -Force $targetTemp }
    New-Item -ItemType Directory -Force -Path $targetTemp | Out-Null
    foreach ($item in $shipped) {
        $src = Join-Path $PluginRoot $item
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination $targetTemp -Recurse -Force
            Log "copied $item"
        }
    }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item -Path $targetTemp -Destination $target
    Log "installed files at $target"
}
elseif ($DryRun) {
    Write-Host "  [dry-run] would copy: lib/, client/, cordis.patch.yml, LICENSE, README.md, package.json -> $target"
}
else {
    Log "skipping file copy (-SkipCopy); manifest only"
}

# ---------------------------------------------------------------------------
# 4. Register dependency + bundle in the profile manifest.
# ---------------------------------------------------------------------------
$pkgPath = Join-Path $profile 'package.json'
if (-not (Test-Path $pkgPath)) {
    throw "profile manifest missing: $pkgPath"
}
$raw = Read-TextFile $pkgPath
if (-not $raw.Trim().StartsWith('{')) {
    throw "package.json does not look like JSON at $pkgPath"
}

$backupPath = Join-Path $profile "package.json.$PluginName.bak"
if (-not (Test-Path $backupPath) -and -not $DryRun) {
    Write-TextFile $backupPath $raw
    Log "manifest backup saved at $backupPath"
}

if ($DryRun) {
    Write-Host "  [dry-run] would add dependency $PluginName@$PluginVersion and bundle entry to $pkgPath"
}
else {
    $pkg = $raw | ConvertFrom-Json
    if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([ordered]@{}) -Force }
    if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile.bundles = @() }
    if (-not $pkg.dependencies.$PluginName) {
        $pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $PluginVersion -Force
        Log "added dependency $PluginName@$PluginVersion"
    }
    else {
        Log "dependency $PluginName already present ($($pkg.dependencies.$PluginName))"
    }
    if ($pkg.dsh.profile.bundles -notcontains $PluginName) {
        $pkg.dsh.profile.bundles += $PluginName
        Log "added bundle entry $PluginName"
    }
    else {
        Log "bundle entry $PluginName already present"
    }
    Write-TextFile $pkgPath ($pkg | ConvertTo-Json -Depth 20)
    Log "updated $pkgPath"
}

# ---------------------------------------------------------------------------
# 5. Verify with Node itself: no BOM, valid JSON, entries present, version match.
# ---------------------------------------------------------------------------
if (-not $DryRun) {
    $verify = "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);if(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF)throw new Error('BOM left in file');const j=JSON.parse(b.toString('utf8'));const n=process.argv[2],v=process.argv[3];if(!j.dependencies||j.dependencies[n]!==v)throw new Error('dependency missing or version mismatch');if(!j.dsh||!j.dsh.profile||!j.dsh.profile.bundles||!j.dsh.profile.bundles.includes(n))throw new Error('bundle missing');console.log('verified: no BOM, valid JSON, '+n+'@'+v+' registered');"
    $verifyResult = & node -e $verify $pkgPath $PluginName $PluginVersion 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  verification failed: $verifyResult"
        if (Test-Path $backupPath) {
            Write-Host "  restoring backup from $backupPath"
            Write-TextFile $pkgPath (Read-TextFile $backupPath)
        }
        throw "package.json verification failed; original restored. See message above."
    }
    Write-Host "  $verifyResult"

    Write-Host "`nDone. Restart dsh (host half) and refresh the page (browser half):"
    Write-Host "  dsh web"
}
else {
    Write-Host "`n[dry-run] complete; nothing was changed."
}