# Best-effort cleanup of a legacy direct-install app so the Digital Habits
# Blocker NSIS installer leaves only one desktop app installed.
#
# Scoped to known prior product names only (allowlist). Does NOT touch
# ProgramData user data, the current "Digital Habits Blocker" install, or
# MSIX/Store packages (those never run this script).
#
# Invoked from NSIS_HOOK_PREINSTALL with no arguments (production defaults).
# Optional parameters override roots/names so the same logic can be verified
# in isolation without touching real Uninstall / Run keys.

param(
    [string[]]$LegacyNames = @('ReDD Blocker', 'ReDD Block', 'Fristed'),
    [string[]]$UninstallRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    ),
    [string]$LocalAppData = $env:LOCALAPPDATA,
    [string]$ProgramData = $env:ProgramData,
    [string]$ProgramFiles = $env:ProgramFiles,
    [string]$ProgramW6432 = $env:ProgramW6432,
    [string]$AppData = $env:APPDATA,
    [string]$UserProfile = $env:USERPROFILE,
    [string]$Public = $env:PUBLIC,
    [string]$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    [string[]]$LegacyWatchdogTasks = @('ReDD Blocker Watchdog', 'ReDD Block Watchdog'),
    [switch]$SkipWatchdog,
    [string]$HostsDirectory = (Join-Path ([System.Environment]::SystemDirectory) 'drivers\etc'),
    [string]$SnapshotFile,
    [switch]$BeforeMaintenance,
    [switch]$ProtectOlderUninstaller
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-QuotedOrTrimmed([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $trim = $Value.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($trim)) { return $null }
    return $trim
}

function Get-RegisteredLegacyDirectory($Registration) {
    $dir = Get-QuotedOrTrimmed $Registration.InstallLocation
    if ($dir) { return $dir }
    if ($Registration.UninstallString -match '^\s*"([^"]+)"|^\s*(\S+)') {
        $exe = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        return Split-Path -Parent $exe
    }
}

function Get-HostsHash([string]$Path) {
    try {
        $null = Get-Item -LiteralPath $Path -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -ErrorAction Stop).Hash
}

function Test-LegacyHostsRisk($Hashes, [string]$SnapshotFolder) {
    if ($null -ne $Hashes['hosts.redd-backup']) { return $true }
    $marker = '^\s*(# === (BEGIN|END) REDD BLOCK \(reddfocus\.org\) ===|# ReDD Block (Start|End))\s*$'
    if ($null -ne $Hashes['hosts'] -and
        (Select-String -LiteralPath (Join-Path $SnapshotFolder 'hosts') -Quiet -Pattern $marker)) {
        return $true
    }
    foreach ($name in ($LegacyNames + 'Digital Habits Blocker')) {
        if (Test-Path -LiteralPath (Join-Path $ProgramData "$name\helper-state.json")) {
            return $true
        }
    }
    if (Get-Process -Name 'redd-block-helper' -ErrorAction SilentlyContinue) { return $true }
    return [bool](Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq 'ReDD Block Helper')
}

# The same-product Tauri maintenance page can run its old uninstaller
# before PREINSTALL. Persist exact copies outside any default install or
# bundle-ID directory, then compare live hosts before proceeding.
if ($BeforeMaintenance) {
    $ErrorActionPreference = 'Stop'
    if (-not $SnapshotFile -or -not $AppData) { throw 'Could not resolve hosts recovery paths' }
    $folder = Join-Path $AppData ("Digital Habits Blocker\backups\nsis-" + [Guid]::NewGuid())
    [void][IO.Directory]::CreateDirectory($folder)
    $hashes = @{}
    foreach ($name in @('hosts', 'hosts.redd-backup')) {
        $source = Join-Path $HostsDirectory $name
        $hash = Get-HostsHash $source
        if ($null -ne $hash) {
            $backup = Join-Path $folder $name
            [IO.File]::Copy($source, $backup)
            if ((Get-HostsHash $backup) -ne $hash) { throw "$name changed during snapshot" }
        }
        if ((Get-HostsHash $source) -ne $hash) { throw "$name changed during snapshot" }
        $hashes[$name] = $hash
    }
    $manifest = @{ Folder = $folder; Hashes = $hashes } | ConvertTo-Json
    [IO.File]::WriteAllText($SnapshotFile, $manifest)
    if ($ProtectOlderUninstaller -and (Test-LegacyHostsRisk $hashes $folder)) {
        Write-Output "The older uninstaller can modify Windows hosts. Recovery copies are in $folder"
        exit 2
    }
    exit 0
}

if ($SnapshotFile) {
    $ErrorActionPreference = 'Stop'
    try {
        $snapshot = [IO.File]::ReadAllText($SnapshotFile) | ConvertFrom-Json
        foreach ($name in @('hosts', 'hosts.redd-backup')) {
            if ((Get-HostsHash (Join-Path $snapshot.Folder $name)) -ne $snapshot.Hashes.$name) {
                throw "Could not verify recovery copy in $($snapshot.Folder)"
            }
        }
        if ((Get-HostsHash (Join-Path $HostsDirectory 'hosts')) -ne $snapshot.Hashes.hosts) {
            throw "Windows hosts changed during setup. Recovery copies are in $($snapshot.Folder)"
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
    $ErrorActionPreference = 'SilentlyContinue'
}

# Remove known prior install directories without executing their
# uninstallers, which may restore a stale hosts file.
$paths = New-Object System.Collections.Generic.List[string]
foreach ($name in $LegacyNames) {
    if ($ProgramFiles) { $paths.Add((Join-Path $ProgramFiles $name)) }
    if ($ProgramW6432) { $paths.Add((Join-Path $ProgramW6432 $name)) }
    if ($LocalAppData) {
        $paths.Add((Join-Path $LocalAppData $name))
        $paths.Add((Join-Path $LocalAppData (Join-Path 'Programs' $name)))
    }
}
foreach ($path in ($paths | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $prefix = $path.TrimEnd('\') + '\'
    Get-Process |
        Where-Object {
            $_.Path -and (
                $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
                $_.Path.Equals($path.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
            )
        } |
        Stop-Process -Force
    Remove-Item -LiteralPath $path -Recurse -Force
}

# Remove stale Apps & Features keys. Preserve the registration for live
# custom installations and for directories the sweep could not remove.
foreach ($name in $LegacyNames) {
    foreach ($root in $UninstallRoots) {
        $key = Join-Path $root $name
        if (Test-Path -LiteralPath $key) {
            $dir = Get-RegisteredLegacyDirectory (Get-ItemProperty -LiteralPath $key)
            if ($dir -and (Test-Path -LiteralPath $dir)) {
                Write-Warning "The legacy installation at $dir needs separate removal."
                continue
            }
            Remove-Item -LiteralPath $key -Recurse -Force
        }
    }
}

# 4. Legacy HKCU Run values (dual-login risk if old exe still existed).
if (Test-Path -LiteralPath $RunKey) {
    foreach ($name in $LegacyNames) {
        Remove-ItemProperty -LiteralPath $RunKey -Name $name -Force
    }
}

# 5. Orphan shortcuts when we only did a directory delete.
foreach ($name in $LegacyNames) {
    $lnk = "$name.lnk"
    $candidates = @()
    if ($AppData) {
        $sm = Join-Path $AppData 'Microsoft\Windows\Start Menu\Programs'
        $candidates += (Join-Path $sm $lnk)
        $candidates += (Join-Path (Join-Path $sm $name) $lnk)
    }
    if ($UserProfile) {
        $candidates += (Join-Path (Join-Path $UserProfile 'Desktop') $lnk)
    }
    if ($Public) {
        $candidates += (Join-Path (Join-Path $Public 'Desktop') $lnk)
    }
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) {
            Remove-Item -LiteralPath $p -Force
        }
    }
    if ($AppData) {
        $folder = Join-Path (Join-Path $AppData 'Microsoft\Windows\Start Menu\Programs') $name
        if ((Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $folder -Force
        }
    }
}

# 6. Legacy watchdog tasks (old PREUNINSTALL would do this; cover dir-only path).
if (-not $SkipWatchdog) {
    foreach ($task in $LegacyWatchdogTasks) {
        Start-Process -FilePath 'schtasks.exe' -ArgumentList @('/Delete', '/TN', $task, '/F') -Wait -WindowStyle Hidden | Out-Null
    }
}
