# Reusable x64 release-mode MSIX for local testing; no Store credentials needed.
param([switch]$Sign, [switch]$Install)
$ErrorActionPreference = "Stop"
# pnpm can carry PowerShell 7's PSModulePath into Windows PowerShell 5.1.
# Resolve built-in modules from this shell first (not incompatible PS7 copies).
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot
try {
    $version = (Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json).version
    $dist = Join-Path $ProjectRoot 'for-distribution/x86_64-pc-windows-msvc'
    $revision = 0
    # Windows refuses an update with different contents and the same version.
    $installed = Get-AppxPackage -Name DigitalHabits.Blocker.LocalTest
    foreach ($package in $installed) {
        $v = [version]$package.Version
        if ($v.ToString(3) -eq $version) { $revision = [Math]::Max($revision, $v.Revision + 1) }
    }
    Get-ChildItem $dist -Filter "Digital-Habits-Blocker-Test_${version}.*_x64.msix" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.BaseName -match '\.(\d+)_x64$') {
            $revision = [Math]::Max($revision, [int]$Matches[1] + 1)
        }
    }
    if ($revision -gt 65535) { throw 'Test revision exhausted; change the app version.' }
    & node scripts/run-tauri.js build --target x86_64-pc-windows-msvc --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed.' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-msix.ps1 -Architecture x64 -LocalTest -TestRevision $revision
    if ($LASTEXITCODE -ne 0) { throw 'MSIX packaging failed.' }
    $packagePath = Join-Path $dist "Digital-Habits-Blocker-Test_${version}.${revision}_x64.msix"
    if ($Sign -or $Install) {
        & "$PSScriptRoot/sign-msix-dev.ps1" -MsixPath $packagePath -LocalTest -Install:$Install
        if ($LASTEXITCODE -ne 0) { throw 'Signing or installation failed.' }
    }
    Write-Host "Test package: $packagePath"
} finally { Pop-Location }
