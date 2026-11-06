# Run without a compiler, SDK, Store credentials, or Pester.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StageScript = Join-Path $PSScriptRoot 'stage-msix-resources.ps1'
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('dh-msix-resources-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $TestRoot | Out-Null

function Assert-Throws($Action, $Message) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    if (-not $failed) { throw $Message }
}

try {
    $Fixture = Join-Path $TestRoot 'project with spaces'
    $Stage = Join-Path $TestRoot 'package with spaces'
    New-Item -ItemType Directory -Path (Join-Path $Fixture 'src-tauri') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src-tauri/blocked') -Destination (Join-Path $Fixture 'src-tauri') -Recurse
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src-tauri/tauri.conf.json') -Destination (Join-Path $Fixture 'src-tauri')

    # No release/resources directory exists: exercise the exact staging script
    # called by build-msix.ps1, using the real resource map and source assets.
    & $StageScript -ProjectRoot $Fixture -StagingDir $Stage
    foreach ($file in @('blocked.html', 'blocked.js', 'reddblock-icon.svg')) {
        $source = Join-Path $Fixture "src-tauri/blocked/$file"
        $dest = Join-Path $Stage "blocked/$file"
        if (-not (Test-Path -LiteralPath $dest -PathType Leaf)) { throw "Missing runtime resource: $dest" }
        if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $dest).Hash) {
            throw "Wrong contents: $dest"
        }
    }
    if (Test-Path -LiteralPath (Join-Path $Stage 'resources/blocked')) { throw 'Resources staged one directory too deep' }
    Write-Host 'PASS: all runtime assets staged beside the executable, with matching hashes'

    Remove-Item -LiteralPath (Join-Path $Fixture 'src-tauri/blocked/blocked.js')
    Assert-Throws { & $StageScript -ProjectRoot $Fixture -StagingDir $Stage } 'Missing source asset did not fail packaging'
    Write-Host 'PASS: missing source fails even if a stale staged copy exists'

    $configPath = Join-Path $Fixture 'src-tauri/tauri.conf.json'
    '{"bundle":{"resources":{"blocked/blocked.html":"resources/blocked/blocked.html"}}}' | Set-Content -LiteralPath $configPath
    Assert-Throws { & $StageScript -ProjectRoot $Fixture -StagingDir (Join-Path $TestRoot 'wrong layout') } 'Incorrect runtime layout did not fail packaging'
    Write-Host 'PASS: incorrect resource mapping fails packaging'
} finally {
    # Only remove the unique temporary directory created above.
    $resolved = [IO.Path]::GetFullPath($TestRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolved) -notlike 'dh-msix-resources-*') { throw 'Unexpected test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
