# Exercises setup against temporary hosts, registration and install fixtures.
# The task and process probes below are mocked. No elevation is required.
$ErrorActionPreference = 'Stop'
$preinstall = Join-Path $PSScriptRoot '../src-tauri/windows/legacy-preinstall.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("redd-hosts-recovery-" + [Guid]::NewGuid())
$hostsDir = Join-Path $fixture 'system'
$registration = Join-Path $fixture 'uninstall'
$customInstall = Join-Path $fixture 'custom'
$knownInstall = Join-Path $fixture 'local/ReDD Blocker'
$customKey = Join-Path $registration 'ReDD Block'
$knownKey = Join-Path $registration 'ReDD Blocker'
$hosts = Join-Path $hostsDir 'hosts'
$backup = Join-Path $hostsDir 'hosts.redd-backup'
$manifest = Join-Path $fixture 'snapshot.json'
$taskMarker = Join-Path $fixture 'running-task-fixture'

function Get-ScheduledTask([string]$TaskPath) {
    if ([IO.File]::Exists($taskMarker)) { [pscustomobject]@{ TaskName = 'ReDD Block Helper' } }
}

function Get-Process {
    [CmdletBinding()]
    param([string]$Name)
}

function Get-ItemProperty([string]$LiteralPath) {
    if ($LiteralPath -eq $customKey) { [pscustomobject]@{ InstallLocation = $customInstall } }
    if ($LiteralPath -eq $knownKey) { [pscustomobject]@{ InstallLocation = $knownInstall } }
}

function Assert-Condition([bool]$Passed, [string]$Message) {
    if (-not $Passed) { throw $Message }
}

function Assert-FileBytes([string]$Path, [byte[]]$Expected) {
    $actualBytes = [IO.File]::ReadAllBytes($Path)
    Assert-Condition ([Convert]::ToBase64String($actualBytes) -ceq [Convert]::ToBase64String($Expected)) "Unexpected bytes in $Path"
}

try {
    foreach ($dir in @($hostsDir, $registration, $customInstall, $knownInstall, $customKey, $knownKey)) {
        [void][IO.Directory]::CreateDirectory($dir)
    }
    $options = @{
        UninstallRoots = @($registration)
        LegacyNames = @('ReDD Blocker', 'ReDD Block')
        AppData = (Join-Path $fixture 'roaming')
        ProgramData = (Join-Path $fixture 'shared')
        LocalAppData = (Join-Path $fixture 'local')
        ProgramFiles = (Join-Path $fixture 'programs')
        ProgramW6432 = (Join-Path $fixture 'programs64')
        UserProfile = (Join-Path $fixture 'profile')
        Public = (Join-Path $fixture 'public')
        RunKey = (Join-Path $fixture 'run')
        HostsDirectory = $hostsDir
        SkipWatchdog = $true
    }
    & $preinstall @options
    Assert-Condition (Test-Path -LiteralPath $customKey) 'Custom installation lost its uninstall registration'
    Assert-Condition (Test-Path -LiteralPath $customInstall) 'Custom installation was removed'
    Assert-Condition (-not (Test-Path -LiteralPath $knownKey)) 'Cleaned install left a stale registration'
    Assert-Condition (-not (Test-Path -LiteralPath $knownInstall)) 'Known old install remained on disk'

    $original = [byte[]]@(49, 50, 55, 13, 10, 255)
    $legacy = [byte[]]@(49, 50, 55, 10)
    [IO.File]::WriteAllBytes($hosts, $original)
    [IO.File]::WriteAllBytes($backup, $legacy)
    & $preinstall @options -BeforeMaintenance -SnapshotFile $manifest -ProtectOlderUninstaller
    Assert-Condition ($LASTEXITCODE -eq 2) 'An unguarded old uninstaller was allowed with a legacy backup'
    $snapshot = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
    Assert-FileBytes (Join-Path $snapshot.Folder 'hosts') $original
    Assert-FileBytes (Join-Path $snapshot.Folder 'hosts.redd-backup') $legacy

    [IO.File]::Delete($backup)
    $global:LASTEXITCODE = 0
    & $preinstall @options -SnapshotFile $manifest
    Assert-Condition ($LASTEXITCODE -eq 0) 'Verified recovery copy did not protect the deleted legacy backup'
    Assert-FileBytes (Join-Path $snapshot.Folder 'hosts.redd-backup') $legacy

    $laterEdit = [byte[]]@(49, 50, 55, 13, 10, 42)
    [IO.File]::WriteAllBytes($hosts, $laterEdit)
    & $preinstall @options -SnapshotFile $manifest
    Assert-Condition ($LASTEXITCODE -eq 1) 'Setup accepted a live hosts change during maintenance'
    Assert-FileBytes $hosts $laterEdit
    Assert-FileBytes (Join-Path $snapshot.Folder 'hosts') $original

    [IO.File]::Delete($hosts)
    [IO.File]::WriteAllText($taskMarker, 'present')
    & $preinstall @options -BeforeMaintenance -SnapshotFile $manifest -ProtectOlderUninstaller
    Assert-Condition ($LASTEXITCODE -eq 2) 'Setup missed task-only legacy residue'
    Assert-Condition (-not (Test-Path -LiteralPath $hosts)) 'Setup manufactured a missing hosts file'
    [IO.File]::Delete($taskMarker)
    & $preinstall @options -BeforeMaintenance -SnapshotFile $manifest -ProtectOlderUninstaller
    Assert-Condition ($LASTEXITCODE -eq 0) 'Setup rejected a missing hosts file without legacy residue'

    [IO.File]::WriteAllBytes($hosts, $laterEdit)
    & $preinstall @options -SnapshotFile $manifest
    Assert-Condition ($LASTEXITCODE -eq 1) 'Setup accepted a newly created hosts file during maintenance'
    Assert-FileBytes $hosts $laterEdit
    Write-Host 'Windows hosts recovery fixtures passed.'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}

# The last fixture deliberately exercises a failing installer subprocess.
# Report the assertions' outcome to callers that propagate LASTEXITCODE.
exit 0
