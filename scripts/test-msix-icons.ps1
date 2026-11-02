param([Parameter(Mandatory = $true)][string]$StagingDir)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $StagingDir 'resources.pri'))) {
    throw 'Missing resources.pri: Windows cannot resolve qualified icon variants.'
}
[xml]$manifest = Get-Content (Join-Path $StagingDir 'AppxManifest.xml')
$visuals = $manifest.Package.Applications.Application.VisualElements
if ($visuals.Square44x44Logo -ne 'Assets\Square44x44Logo.png') {
    throw 'Launcher logo must reference a logical resource, not a fixed scale.'
}
$makepri = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makepri.exe' |
    Sort-Object FullName -Descending | Select-Object -First 1
$dumpPath = Join-Path ([IO.Path]::GetTempPath()) ("msix-icons-$([guid]::NewGuid()).xml")
try {
    & $makepri.FullName dump /if (Join-Path $StagingDir 'resources.pri') /of $dumpPath /dt detailed /o | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect icon resource index.' }
    [xml]$dump = Get-Content $dumpPath
    $logo = $dump.SelectSingleNode('//NamedResource[@name="Square44x44Logo.png"]')
    foreach ($suffix in 'scale-125', 'scale-150', 'scale-200', 'scale-400',
        'targetsize-24_altform-unplated', 'targetsize-24_altform-lightunplated') {
        if (-not $logo -or $logo.InnerXml -notlike "*$suffix.png*") {
            throw "Launcher variant is not indexed in resources.pri: $suffix"
        }
    }
} finally { if (Test-Path $dumpPath) { Remove-Item -LiteralPath $dumpPath -Force } }
Add-Type -AssemblyName System.Drawing
# Validate the dimensions of each manifest image, including splash resources.
# A square tile cannot double as a 620x300 splash screen.
$imageRoles = @(
    @{ Resource = $visuals.Square150x150Logo; Width = 150; Height = 150 },
    @{ Resource = $visuals.DefaultTile.Square310x310Logo; Width = 310; Height = 310 },
    @{ Resource = $visuals.SplashScreen.Image; Width = 620; Height = 300 }
)
foreach ($role in $imageRoles) {
    foreach ($scale in 100, 125, 150, 200, 400) {
        $relativePath = $role.Resource -replace '\.png$', ".scale-$scale.png"
        $bitmap = [Drawing.Bitmap]::new((Join-Path $StagingDir $relativePath))
        try {
            $width = [Math]::Floor($role.Width * $scale / 100 + 0.5)
            $height = [Math]::Floor($role.Height * $scale / 100 + 0.5)
            if ($bitmap.Width -ne $width -or $bitmap.Height -ne $height) {
                throw "Invalid manifest image dimensions: $relativePath; expected ${width}x${height}, got $($bitmap.Width)x$($bitmap.Height)"
            }
        } finally { $bitmap.Dispose() }
    }
}
foreach ($size in 16, 20, 24, 32, 40, 44, 48, 64, 96, 256) {
    foreach ($form in 'unplated', 'lightunplated') {
        $path = Join-Path $StagingDir "Assets\Square44x44Logo.targetsize-${size}_altform-${form}.png"
        $bitmap = [Drawing.Bitmap]::new($path)
        try {
            if ($bitmap.Width -ne $size -or $bitmap.Height -ne $size -or $bitmap.GetPixel(0,0).A -ne 0) {
                throw "Invalid dimensions or transparency: $path"
            }
        } finally { $bitmap.Dispose() }
    }
}
Write-Host 'MSIX icon resource checks passed.'
