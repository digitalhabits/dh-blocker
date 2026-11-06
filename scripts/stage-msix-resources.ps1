param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$StagingDir
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'src-tauri'))
$destinationRoot = [IO.Path]::GetFullPath($StagingDir)
$config = Get-Content -LiteralPath (Join-Path $sourceRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
$resources = $config.bundle.resources
if ($resources -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'MSIX staging requires bundle.resources to be an explicit source-to-destination file map.'
}

function Resolve-ResourcePath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative)) {
        throw "Resource path must be relative: $Relative"
    }
    $resolved = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $resolved.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resource path escapes its root: $Relative"
    }
    return $resolved
}

# Validate everything before copying. Do not accept a stale staged file when
# its source has disappeared or its config mapping no longer matches runtime.
$files = @($resources.PSObject.Properties | ForEach-Object {
    if ($_.Value -isnot [string]) { throw "Invalid resource destination: $($_.Name)" }
    $source = Resolve-ResourcePath $sourceRoot $_.Name
    $destination = Resolve-ResourcePath $destinationRoot $_.Value
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required MSIX resource source is missing: $source"
    }
    [PSCustomObject]@{ Source = $source; Destination = $destination; Relative = $_.Value.Replace('\', '/') }
})

# Tauri's Windows resource_dir() is the executable's directory. The HTML
# loads blocked.js and reddblock-icon.svg by relative URL. Keep all three at
# the package root's blocked/, not under an optional release/resources/.
foreach ($required in @('blocked/blocked.html', 'blocked/blocked.js', 'blocked/reddblock-icon.svg')) {
    if ($required -cnotin $files.Relative) {
        throw "bundle.resources must stage $required beside redd-block.exe"
    }
}
foreach ($file in $files) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $file.Destination) -Force | Out-Null
    Copy-Item -LiteralPath $file.Source -Destination $file.Destination -Force
    if ((Get-FileHash -LiteralPath $file.Source).Hash -ne (Get-FileHash -LiteralPath $file.Destination).Hash) {
        throw "MSIX resource verification failed: $($file.Destination)"
    }
}
Write-Host "    Staged and verified $($files.Count) configured resources beside redd-block.exe" -ForegroundColor Gray
